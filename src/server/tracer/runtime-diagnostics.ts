import type { EvaluatorRunResult, JsonObject } from "@/src/lib/tracer/contracts"
import { fetchWithRetry } from "@/src/lib/tracer/retry"

export type RuntimeCategory =
  | "configuration"
  | "authorization"
  | "rate_limit"
  | "quota"
  | "unavailable"
  | "timeout"
  | "invalid_response"
export type RuntimeDiagnostic = {
  category: RuntimeCategory
  message: string
  httpStatus?: number
  providerCode?: string
  requestId?: string
  retryAfter?: string
}
const codes = new Set([
  "insufficient_quota",
  "quota_exceeded",
  "billing_hard_limit_reached",
  "rate_limit_exceeded",
  "rate_limit_error",
  "too_many_requests",
  "invalid_api_key",
  "authentication_error",
  "permission_denied",
  "model_not_found",
  "model_not_available",
  "insufficient_credits",
  "credit_balance_too_low",
])
const quotas = new Set([
  "insufficient_quota",
  "quota_exceeded",
  "billing_hard_limit_reached",
  "insufficient_credits",
  "credit_balance_too_low",
])

async function boundedErrorBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 32_768) return null
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    return null
  } finally {
    void reader.cancel().catch(() => {})
  }
}

export async function providerDiagnostic(
  response: Response
): Promise<RuntimeDiagnostic> {
  const parsed = await boundedErrorBody(response)
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const body = record(parsed)
  const error = record(body.error)
  // TypeSafe has top-level message/detail/error_type; Gateway/chat commonly nest error.
  const candidate = [
    error.code,
    error.type,
    body.code,
    body.error_type,
    body.type,
  ].find((value) => typeof value === "string" && codes.has(value))
  // Only known machine codes and recognized restrictions are exposed; never echo upstream prose.
  const providerCode =
    typeof candidate === "string" && codes.has(candidate)
      ? candidate
      : undefined
  const message = [error.message, body.message, body.error, body.detail]
    .filter((value) => typeof value === "string")
    .join(" ")
  const explicitQuota =
    Boolean(providerCode && quotas.has(providerCode)) ||
    /\b(insufficient credits|credit balance is too low|exceeded your current quota|Free tier users do not have access to this model)\b/i.test(
      message
    )
  const category: RuntimeCategory = explicitQuota
    ? "quota"
    : [401, 403].includes(response.status)
      ? "authorization"
      : response.status === 429
        ? "rate_limit"
        : [408, 504].includes(response.status)
          ? "timeout"
          : response.status >= 500
            ? "unavailable"
            : "invalid_response"
  const descriptions: Record<RuntimeCategory, string> = {
    configuration:
      "Configure this scorer's model provider in project settings.",
    authorization:
      "Provider denied access. Check the selected provider key and model permissions.",
    rate_limit:
      "Provider rate limit reached. Wait before retrying or reduce concurrency; HTTP 429 alone does not establish a quota restriction.",
    quota:
      "Provider explicitly reported a quota or credit restriction. Check the account's quota, paid credits, and model access.",
    unavailable:
      "Provider is unavailable. Retry later or select another provider and recalibrate.",
    timeout:
      "Provider request timed out. Retry a smaller case or check provider availability.",
    invalid_response:
      "Provider rejected the request. Check model support for the requested scoring format.",
  }
  const rawId =
    response.headers.get("x-request-id") ??
    response.headers.get("request-id") ??
    response.headers.get("x-vercel-id")
  const requestId =
    rawId &&
    /^[A-Za-z0-9:_-]{1,128}$/.test(rawId) &&
    !/(sk-|bearer|token|secret|key)/i.test(rawId)
      ? rawId
      : undefined
  const rawRetry = response.headers.get("retry-after")
  const retryAfter =
    rawRetry &&
    rawRetry.length < 80 &&
    (/^\d+(\.\d+)?$/.test(rawRetry) || Number.isFinite(Date.parse(rawRetry)))
      ? rawRetry
      : undefined
  return {
    category,
    message: `${descriptions[category]} (HTTP ${response.status})`,
    httpStatus: response.status,
    ...(providerCode ? { providerCode } : {}),
    ...(requestId ? { requestId } : {}),
    ...(retryAfter ? { retryAfter } : {}),
  }
}

export class ProviderExecutionError extends Error {
  constructor(readonly diagnostic: RuntimeDiagnostic) {
    super(diagnostic.message)
  }
}

/** Both chat and native evaluation adapters share bounded retries and safe diagnostics. */
export function judgeTransport(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 60_000,
  sleep?: (ms: number) => Promise<void>
) {
  let diagnostic: RuntimeDiagnostic | undefined
  let attempts = 0
  const request: typeof fetch = async (url, init) => {
    const started = Date.now()
    const wrapped: typeof fetch = async (target, options) => {
      attempts++
      try {
        return await fetchImpl(target, {
          ...options,
          redirect: "error",
          signal: AbortSignal.any([
            AbortSignal.timeout(
              Math.max(1, timeoutMs - (Date.now() - started))
            ),
            ...(init?.signal ? [init.signal] : []),
          ]),
        })
      } catch (error) {
        const timedOut =
          Date.now() - started >= timeoutMs ||
          (error instanceof Error &&
            ["TimeoutError", "AbortError"].includes(error.name))
        diagnostic = {
          category: timedOut ? "timeout" : "unavailable",
          message: timedOut
            ? "Provider request timed out."
            : "Could not connect to the selected provider. Check connectivity and retry later.",
        }
        throw new ProviderExecutionError(diagnostic)
      }
    }
    let response: Response
    try {
      response = await fetchWithRetry(wrapped, String(url), init ?? {}, {
        timeoutMs,
        retries: 1,
        retryTransport: false,
        maxRetryDelayMs: 2000,
        sleep,
        retryResponse: async (response) => {
          diagnostic = await providerDiagnostic(response.clone())
          return (
            ["rate_limit", "unavailable"].includes(diagnostic.category) &&
            Date.now() - started < timeoutMs - 2500
          )
        },
      })
    } catch {
      throw new ProviderExecutionError(
        diagnostic ?? {
          category: "unavailable",
          message: "Could not reach the selected provider.",
        }
      )
    }
    if (!response.ok) {
      diagnostic = await providerDiagnostic(response)
      throw new ProviderExecutionError(diagnostic)
    }
    diagnostic = undefined
    return response
  }
  return {
    fetch: request,
    get diagnostic() {
      return diagnostic
    },
    get attempts() {
      return attempts
    },
  }
}

export function diagnosticResult(
  diagnostic: RuntimeDiagnostic,
  metadata: JsonObject = {}
): EvaluatorRunResult {
  return {
    score: null,
    passed: null,
    error: {
      kind: diagnostic.category === "timeout" ? "timeout" : "runtime",
      message: diagnostic.message,
    },
    metadata: {
      ...metadata,
      runtimeDiagnostic: { ...diagnostic },
      ...(diagnostic.httpStatus
        ? { judgeHttpStatus: diagnostic.httpStatus }
        : {}),
    },
  }
}

export function blocksRuntime(result: EvaluatorRunResult) {
  const diagnostic = result.metadata?.runtimeDiagnostic
  return Boolean(
    result.error &&
    (result.error.kind === "sandbox" ||
      (diagnostic &&
        typeof diagnostic === "object" &&
        !Array.isArray(diagnostic) &&
        [
          "configuration",
          "authorization",
          "rate_limit",
          "quota",
          "unavailable",
          "timeout",
        ].includes(String(diagnostic.category))))
  )
}

/** Serial admission per runtime prevents concurrent targets from stampeding a failing provider. */
export class RuntimeCircuit {
  private failures = new Map<string, EvaluatorRunResult>()
  private tails = new Map<string, Promise<void>>()
  async run(
    key: string,
    execute: () => Promise<EvaluatorRunResult>
  ): Promise<EvaluatorRunResult> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    this.tails.set(
      key,
      previous.then(() => next)
    )
    await previous
    try {
      const failure = this.failures.get(key)
      if (failure)
        return {
          score: null,
          passed: null,
          error: {
            kind: failure.error!.kind,
            message: `Scorer was not executed because this runtime failed earlier in the run. ${failure.error!.message}`,
          },
          metadata: {
            runtimeCircuitOpen: true,
            ...(failure.metadata?.runtimeDiagnostic
              ? { runtimeDiagnostic: failure.metadata.runtimeDiagnostic }
              : {}),
          },
        }
      const result = await execute()
      if (blocksRuntime(result)) this.failures.set(key, result)
      return result
    } finally {
      release()
    }
  }
}
