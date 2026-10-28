/** Wire contract: deliberately no free-form messages, URLs, headers or user data. */
export const diagnosticStages = ["google_sign_in", "google_session", "email_sign_in", "email_callback", "session", "api", "render"] as const
export const diagnosticCodes = ["UNKNOWN", "NETWORK_ERROR", "TIMEOUT", "HTTP_ERROR", "SESSION_MISSING", "INVALID_CALLBACK", "INVALID_STATE", "STATE_MISMATCH", "STATE_NOT_FOUND", "USER_NOT_FOUND", "UNABLE_TO_GET_USER_INFO", "EMAIL_DOMAIN_NOT_ALLOWED", "ACCESS_DENIED", "OAUTH_FAILED", "EMAIL_DELIVERY_FAILED", "RATE_LIMITED", "TYPE_ERROR", "REFERENCE_ERROR"] as const
export type DiagnosticStage = typeof diagnosticStages[number]
export type DiagnosticCode = typeof diagnosticCodes[number]
export type DiagnosticReport = {
  id: string
  occurredAt: string
  stage: DiagnosticStage
  code: DiagnosticCode
  platform: "ios" | "android" | "web"
  appVersion: string
  buildVersion: string
  online: boolean
  httpStatus?: number
}

/** Unknown provider prose is never serialized, including Error.message/stack/cause. */
export function diagnosticError(error: unknown): Pick<DiagnosticReport, "code" | "httpStatus"> {
  const value = error && typeof error === "object" ? error as { code?: unknown; status?: unknown; name?: unknown; message?: unknown } : {}
  const known = typeof value.code === "string" ? value.code.toUpperCase() : ""
  const httpStatus = typeof value.status === "number" && Number.isInteger(value.status) && value.status >= 400 && value.status <= 599 ? value.status : undefined
  const code: DiagnosticCode = diagnosticCodes.includes(known as DiagnosticCode) ? known as DiagnosticCode
    : value.name === "TimeoutError" || value.name === "AbortError" ? "TIMEOUT"
    : value.message === "Network request failed" || value.message === "Failed to fetch" ? "NETWORK_ERROR"
    : httpStatus === 429 ? "RATE_LIMITED"
    : httpStatus ? "HTTP_ERROR"
    : value.name === "TypeError" ? "TYPE_ERROR"
    : value.name === "ReferenceError" ? "REFERENCE_ERROR" : "UNKNOWN"
  return { code, ...(httpStatus ? { httpStatus } : {}) }
}
