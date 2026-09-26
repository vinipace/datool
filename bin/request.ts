import {
  retryDelayMs,
  retryBackoffMs,
  transientHttpStatuses,
} from "../src/lib/tracer/retry"
import { serverOrigin } from "./config"
import { readProfile } from "./credentials"
import { accessCredential } from "./oauth"
import { workspaceScopes } from "../src/lib/auth/permissions"

export class DatoolRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly missingScopes: string[] = [],
    readonly retryAfterMs = 0,
    readonly category:
      | "throttled"
      | "authorization"
      | "disconnected"
      | "unavailable"
      | "invalid_response"
      | "request" = "request"
  ) {
    super(message)
  }
}

/** Shared transport for every project-scoped CLI command. */
export async function appRequest<T>(
  origin: string,
  path: string,
  body?: unknown,
  options?: {
    timeoutMs?: number
    retry?: "read"
    retryBudgetMs?: number
    signal?: AbortSignal
  }
): Promise<T> {
  origin = serverOrigin(origin)
  let projectId = process.env.DATOOL_PROJECT_ID?.trim()
  const apiKey = process.env.DATOOL_API_KEY?.trim()
  let token = apiKey
  if (!token) {
    const profile = await readProfile()
    if (profile) {
      if (origin !== profile.origin)
        throw new Error(
          "Saved OAuth login belongs to a different host. Run datool auth login --datool <url>."
        )
      if (projectId && projectId !== profile.projectId)
        throw new Error(
          "Saved OAuth login belongs to a different project. Run datool auth login and select that project."
        )
      projectId = profile.projectId
      token = (await accessCredential(profile)).accessToken
    }
  }
  if (!projectId)
    throw new Error("Set DATOOL_PROJECT_ID or pass --project <id>.")
  if (!token)
    throw new Error(
      "Run datool auth login or set DATOOL_API_KEY to an organization API key with the required permissions."
    )
  const started = Date.now()
  for (let attempt = 0; ; attempt++) {
    try {
      let response: Response
      try {
        response = await fetch(`${origin.replace(/\/$/, "")}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "x-project-id": projectId,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: options?.signal
            ? AbortSignal.any([
                options.signal,
                AbortSignal.timeout(options?.timeoutMs ?? 10_000),
              ])
            : AbortSignal.timeout(options?.timeoutMs ?? 10_000),
          redirect: "error",
        })
      } catch {
        throw new DatoolRequestError(
          "Datool connection failed or timed out. Completion of a mutation is unknown; inspect its existing request before trying again.",
          undefined,
          [],
          0,
          "disconnected"
        )
      }
      // Never echo arbitrary upstream messages or bodies, which can contain credentials.
      if (!response.ok) {
        const error = await response.json().catch(() => null)
        const missing =
          response.status === 403 &&
          error?.error?.details?.reason === "INSUFFICIENT_SCOPE" &&
          Array.isArray(error.error.details.missingScopes)
            ? (error.error.details.missingScopes.filter(
                (scope: unknown) =>
                  typeof scope === "string" &&
                  (workspaceScopes as readonly string[]).includes(scope)
              ) as string[])
            : []
        let advice = ""
        let category: DatoolRequestError["category"] = "request"
        switch (response.status) {
          case 401:
            advice =
              " Authentication failed: credential is invalid, expired, or revoked."
            category = "authorization"
            break
          case 403:
            advice = missing.length
              ? ` Missing permission: ${missing.join(", ")}. Grant these scopes or use a credential that has them.`
              : " Permission denied for the selected project or operation."
            category = "authorization"
            break
          case 429:
            advice = " Temporarily throttled by Datool."
            category = "throttled"
            break
          default:
            if (transientHttpStatuses.includes(response.status))
              category = "unavailable"
        }
        throw new DatoolRequestError(
          `Datool request failed (HTTP ${response.status}).${advice}`,
          response.status,
          missing,
          retryDelayMs(
            response.headers.get("retry-after"),
            error?.error?.details?.retryAfterSeconds
          ),
          category
        )
      }
      const payload = await response.json().catch(() => {
        throw new DatoolRequestError(
          "Datool response was interrupted or invalid.",
          undefined,
          [],
          0,
          "disconnected"
        )
      })
      if (!payload || typeof payload !== "object" || !("data" in payload)) {
        throw new DatoolRequestError(
          "Datool returned an invalid response envelope.",
          response.status,
          [],
          0,
          "invalid_response"
        )
      }
      return payload.data as T
    } catch (error) {
      const safe = body === undefined || options?.retry === "read"
      const transient =
        error instanceof DatoolRequestError &&
        (error.category === "disconnected" ||
          transientHttpStatuses.includes(error.status ?? 0))
      const wait =
        error instanceof DatoolRequestError
          ? retryBackoffMs(attempt, error.retryAfterMs)
          : 0
      if (
        !safe ||
        !transient ||
        options?.signal?.aborted ||
        attempt >= 8 ||
        Date.now() - started + wait > (options?.retryBudgetMs ?? 120_000)
      )
        throw error
      console.error(
        `Datool ${error.category}; retrying read in ${Math.ceil(wait / 1000)}s.`
      )
      await new Promise<void>((resolve, reject) => {
        const aborted = () => {
          clearTimeout(timer)
          reject(options?.signal?.reason)
        }
        const timer = setTimeout(() => {
          options?.signal?.removeEventListener("abort", aborted)
          resolve()
        }, wait)
        options?.signal?.addEventListener("abort", aborted, { once: true })
      })
    }
  }
}
