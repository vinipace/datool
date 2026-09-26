import { NextResponse } from "next/server"
import { apiErrorHint } from "./api-error-hint"

export type ApiErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "PAYLOAD_TOO_LARGE"
  | "CONFLICT"
  | "INTERNAL_ERROR"

export function apiError(code: ApiErrorCode, message: string, status: number) {
  return NextResponse.json(
    { error: { code, message, hint: apiErrorHint(status) } },
    { status, headers: { "Cache-Control": "no-store" } }
  )
}

export function accessError(kind: "unauthenticated" | "forbidden" | "not-found" | "payment-required") {
  if (kind === "payment-required") return apiError("FORBIDDEN", "An active Cloud subscription is required. Open /billing.", 402)
  if (kind === "unauthenticated") return apiError("UNAUTHENTICATED", "Authentication is required.", 401)
  if (kind === "forbidden") return apiError("FORBIDDEN", "You do not have access to this resource.", 403)
  return apiError("NOT_FOUND", "Resource not found.", 404)
}

export type JsonBodyResult =
  | { kind: "ok"; value: unknown }
  | { kind: "invalid" }
  | { kind: "too-large" }

/**
 * Reads JSON with an actual streaming limit. Content-Length is only an early
 * rejection hint because clients can omit or lie about it.
 */
export async function readJson(request: Request, maxBytes: number): Promise<JsonBodyResult> {
  const contentLength = request.headers.get("content-length")
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    return { kind: "too-large" }
  }

  try {
    if (!request.body) return { kind: "invalid" }
    const reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        return { kind: "too-large" }
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { kind: "ok", value: JSON.parse(new TextDecoder().decode(bytes)) }
  } catch {
    return { kind: "invalid" }
  }
}

/** Applies the same-origin protection Better Auth expects for cookie sessions. */
export function hasTrustedMutationOrigin(request: Request): boolean {
  const origin = request.headers.get("origin")
  if (!origin) return !request.headers.has("cookie")

  const configuredBaseUrl = process.env.BETTER_AUTH_URL
  if (!configuredBaseUrl) return false
  let expectedOrigin: string
  try {
    expectedOrigin = new URL(configuredBaseUrl).origin
  } catch {
    return false
  }
  return origin === expectedOrigin
}
