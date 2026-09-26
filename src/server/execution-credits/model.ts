import { DATOOL_SCORER_MODEL } from "@/src/lib/execution-credits"
import { executionCredits, ExecutionCreditError } from "./ledger"

export const MODEL_RATE_VERSION = "gpt-6-luna-standard-2026-09-22"
export const MODEL_RESERVATION = 16_000 * 100 + 4096 * 500
const whole = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
/** Responses and Chat usage both include reasoning in their output token total. */
export function modelUsageCharge(body: Record<string, unknown>) {
  const usage = body.usage as Record<string, unknown> | undefined
  if (!usage) return null
  const input = usage.input_tokens ?? usage.prompt_tokens
  const output = usage.output_tokens ?? usage.completion_tokens
  const details = (usage.input_tokens_details ??
    usage.prompt_tokens_details) as Record<string, unknown> | undefined
  const cached = details?.cached_tokens ?? 0
  if (
    !whole(input) ||
    !whole(output) ||
    !whole(cached) ||
    Number(cached) > Number(input)
  )
    return null
  const amount =
    (Number(input) - Number(cached)) * 100 +
    Number(cached) * 10 +
    Number(output) * 500
  return { amount, input, output, cached }
}

/** A server-owned transport. Every HTTP attempt reserves independently, including retries. */
export function managedModelFetch(
  projectId: string,
  operations: string[],
  transport: typeof fetch = fetch,
  credits = executionCredits
): typeof fetch {
  return (async (input, init) => {
    const url = String(input)
    if (
      !/^https:\/\/api\.openai\.com\/v1\/(responses|chat\/completions)$/.test(
        url
      ) ||
      init?.method !== "POST" ||
      typeof init.body !== "string"
    )
      throw new Error("Invalid managed model request.")
    const body = JSON.parse(init.body)
    // Cap the complete serialized input (including schema); byte bound is safely
    // below the reserved token budget. Images, hosted tools, streaming and custom tiers
    // require separate metering and are deliberately excluded from this route.
    if (
      Buffer.byteLength(init.body) > 12_000 ||
      body.model !== DATOOL_SCORER_MODEL ||
      /"(?:image_url|input_image|file_id|input_audio)"\s*:/.test(init.body) ||
      /"type"\s*:\s*"(?:input_image|input_file|input_audio|image_url|file)"/.test(
        init.body
      ) ||
      body.stream ||
      body.background ||
      body.previous_response_id ||
      body.conversation ||
      (body.tools &&
        (!Array.isArray(body.tools) ||
          body.tools.some(
            (tool: { type?: string }) => tool.type !== "function"
          )))
    ) {
      return Response.json(
        {
          error: {
            code: "invalid_request",
            message:
              "Datool Scorer Model supports text-only requests up to 12 KB.",
          },
        },
        { status: 400 }
      )
    }
    const isResponses = url.endsWith("/responses")
    delete body.max_tokens
    delete body.service_tier
    body.service_tier = "default"
    // Function definitions are output schemas for bundled library classifiers;
    // no hosted tool execution or stored conversation can incur extra charges.
    if (body.tools?.length) body.parallel_tool_calls = false
    if (!isResponses) body.n = 1
    body[isResponses ? "max_output_tokens" : "max_completion_tokens"] = 4096
    if (isResponses) body.store = false
    let operation: string
    try {
      operation = await credits.reserve(
        projectId,
        "model",
        MODEL_RESERVATION,
        MODEL_RATE_VERSION
      )
    } catch (error) {
      if (!(error instanceof ExecutionCreditError)) throw error
      return Response.json(
        { error: { code: "insufficient_credits", message: error.message } },
        { status: 402 }
      )
    }
    operations.push(operation)
    // No catch/refund on network failure: the provider may already have accepted
    // the request. Its reservation stays visible for reconciliation.
    const response = await transport(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DATOOL_SCORER_OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
      redirect: "error",
    })
    const providerId = response.headers.get("x-request-id")
    await credits.recordEvidence(operation, providerId, {
      httpStatus: response.status,
    })
    if ([400, 401, 403, 404, 422, 429].includes(response.status)) {
      await credits.settle(operation, 0, providerId, {
        httpStatus: response.status,
        rejected: true,
      })
      return response
    }
    // Buffer at most 256 KB; never clone an unbounded provider response.
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > 256 * 1024)
            throw new Error("Managed model response exceeded its limit.")
          chunks.push(value)
        }
      } finally {
        void reader.cancel().catch(() => {})
      }
    }
    const text = Buffer.concat(chunks).toString("utf8")
    try {
      const data = JSON.parse(text)
      const usage = modelUsageCharge(data)
      if (usage)
        await credits.settle(
          operation,
          usage.amount,
          providerId ?? data.id ?? null,
          { ...usage, model: DATOOL_SCORER_MODEL }
        )
    } catch {
      /* Invalid/missing usage or uncertain settlement remains reserved. */
    }
    return new Response(text, {
      status: response.status,
      headers: response.headers,
    })
  }) as typeof fetch
}
