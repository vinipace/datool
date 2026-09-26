type AuthErrorDetails = {
  code?: string
  message?: string
  status?: number
}

function details(error: unknown): AuthErrorDetails {
  if (!error || typeof error !== "object") return {}

  const source = error as Record<string, unknown>
  const nested =
    source.error && typeof source.error === "object"
      ? (source.error as Record<string, unknown>)
      : undefined
  const status = source.status ?? source.statusCode ?? nested?.status

  return {
    code:
      typeof (source.code ?? nested?.code) === "string"
        ? String(source.code ?? nested?.code)
        : undefined,
    message:
      typeof (source.message ?? nested?.message) === "string"
        ? String(source.message ?? nested?.message)
        : undefined,
    status: typeof status === "number" ? status : undefined,
  }
}

export function authErrorMessage(
  error: unknown,
  action: "sign-in" | "sign-up"
) {
  const { code, message, status } = details(error)
  const serverFailure =
    (status !== undefined && status >= 500) ||
    code === "SCHEMA_MISMATCH" ||
    code === "INTERNAL_SERVER_ERROR" ||
    error instanceof TypeError ||
    /\b(500|internal server|schema mismatch)\b/i.test(message ?? "")

  if (serverFailure) {
    return action === "sign-up"
      ? "We’re having trouble creating accounts right now. Please try again shortly."
      : "We’re having trouble signing you in right now. Please try again shortly."
  }

  if (status !== undefined && status >= 400 && status < 500 && message) {
    return message
  }

  return action === "sign-up"
    ? "We couldn't create your account. Check your details and try again."
    : "We couldn't sign you in. Check your details and try again."
}

export function oauthErrorMessage(code: string | null) {
  if (code === "account_not_linked") {
    return "An account with this email already exists, but Google is not linked. Contact your administrator to verify the existing account before trying again."
  }
  if (code === "unable_to_get_user_info") {
    return "We couldn't verify your Google profile. Use a verified Google account from an approved domain."
  }
  return "Google sign-in could not be completed. Please try again or contact your administrator."
}

export function signInLinkErrorMessage(code: string | null) {
  if (code === "INVALID_TOKEN")
    return "This sign-in link has expired or was already used. Request a new link below."
  if (code === "EMAIL_DOMAIN_NOT_ALLOWED")
    return "Email sign-in is not available for this address."
  return "This sign-in link could not be verified. Request a new link below."
}
