import { createHash } from "node:crypto"
import { APIError } from "better-auth/api"

export const signInLinkExpirySeconds = 10 * 60

export function authEmailConfigured() {
  return Boolean(
    process.env.RESEND_API_KEY?.trim() && process.env.RESEND_FROM_EMAIL?.trim()
  )
}

/** Resend credentials and sign-in tokens stay on the server. */
export async function sendSignInLink({
  email,
  url,
  token,
}: {
  email: string
  url: string
  token: string
}) {
  if (!authEmailConfigured()) {
    throw new APIError("SERVICE_UNAVAILABLE", {
      code: "EMAIL_SIGN_IN_UNAVAILABLE",
      message: "Email sign-in is currently unavailable. Please try Google.",
    })
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `sign-in/${createHash("sha256").update(token).digest("hex")}`,
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL,
        to: [email],
        subject: "Sign in to Datool",
        text: `Sign in to Datool\n\nOpen this link to securely sign in:\n${url}\n\nThis link expires in 10 minutes and can only be used once. If you didn't request it, you can ignore this email.`,
      }),
    })
    if (!response.ok || !(await response.json()).id)
      throw new Error("Email delivery failed")
  } catch {
    // Never expose provider responses, credentials, or the sign-in link to the browser/logs.
    throw new APIError("SERVICE_UNAVAILABLE", {
      code: "EMAIL_DELIVERY_FAILED",
      message: "We couldn’t send the sign-in link. Please try again shortly.",
    })
  }
}
