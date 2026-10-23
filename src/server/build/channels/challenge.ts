export class PublicChallengeRequiredError extends Error {
  readonly code = "PUBLIC_CHALLENGE_REQUIRED"
  constructor(
    readonly siteKey: string,
    readonly connectionId: string
  ) {
    super("Please complete the security check to start chatting.")
  }
}

/** Managed Turnstile decides whether an interactive challenge is necessary. */
export async function verifyNewVisitorChallenge(
  connectionId: string,
  token?: string
) {
  const siteKey = process.env.DATOOL_TURNSTILE_SITE_KEY
  const secret = process.env.DATOOL_TURNSTILE_SECRET_KEY
  if (!siteKey && !secret) return
  if (!siteKey || !secret) throw new Error("Chat security is unavailable.")
  const reject = () => new PublicChallengeRequiredError(siteKey, connectionId)
  if (!token || token.length > 2048) throw reject()
  try {
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret, response: token }),
      }
    )
    const result = await response.json()
    const hostname = new URL(
      process.env.BETTER_AUTH_URL || "https://invalid.local"
    ).hostname
    if (
      !response.ok ||
      result.success !== true ||
      result.hostname !== hostname ||
      result.action !== "datool_chat" ||
      result.cdata !== connectionId
    )
      throw reject()
  } catch {
    throw reject()
  }
}

export function challengeResponse(error: unknown) {
  if (!(error instanceof PublicChallengeRequiredError)) return null
  return Response.json(
    {
      error: {
        message: error.message,
        code: error.code,
        siteKey: error.siteKey,
        connectionId: error.connectionId,
      },
    },
    {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    }
  )
}
