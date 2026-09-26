import { APIError } from "better-auth/api"
import type { Pool } from "pg"

export const invitationLifetimeSeconds = 48 * 60 * 60

export function invitationEmailConfigured() {
  return !!(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL)
}

export function requireInvitationEmail() {
  if (!invitationEmailConfigured())
    throw new APIError("SERVICE_UNAVAILABLE", {
      message: "Email invitations are not configured on this installation.",
    })
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!
  )
}

type InvitationEmail = {
  id: string
  email: string
  role: string
  organization: { name: string }
  inviter: { user: { name: string } }
}

/** Await provider acceptance; never report a successful invitation email after
 * a failure. A durable payload/key makes uncertain network retries idempotent. */
export async function sendInvitationEmail(
  database: Pool,
  baseUrl: string,
  data: InvitationEmail
) {
  requireInvitationEmail()
  const client = await database.connect()
  const lock = `invitation-email:${data.id}`
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
      lock,
    ])
    const existing = (
      await client.query<{
        attempt_id: string
        payload: unknown
        status: string
        attempted_at: Date
        sent_at: Date | null
      }>("SELECT * FROM invitation_email WHERE invitation_id=$1", [data.id])
    ).rows[0]
    if (existing?.sent_at && Date.now() - existing.sent_at.getTime() < 60_000)
      return
    const url = new URL(
      `/invite/${encodeURIComponent(data.id)}`,
      baseUrl
    ).toString()
    const organization = data.organization.name
    const inviter = data.inviter.user.name
    const payload = {
      from: process.env.RESEND_FROM_EMAIL!,
      to: [data.email],
      subject: `Join ${organization} on Datool`
        .replace(/[\r\n]/g, " ")
        .slice(0, 200),
      text: `${inviter} invited you to join ${organization} on Datool as ${data.role}.\n\nAccept invitation: ${url}\n\nSign in with ${data.email}. This invitation expires in 48 hours. If you were not expecting it, you can ignore this email.`,
      html: `<h1>You're invited to ${escapeHtml(organization)}</h1><p>${escapeHtml(inviter)} invited you to join their Datool organization as <strong>${escapeHtml(data.role)}</strong>.</p><p><a href="${escapeHtml(url)}">Accept invitation</a></p><p>Sign in with ${escapeHtml(data.email)}. This invitation expires in 48 hours.</p><p>If you were not expecting it, you can ignore this email.</p>`,
    }
    // Resend retains idempotency keys for 24h. Explicit resends after a confirmed
    // send create a new attempt; failed/uncertain attempts reuse the frozen body.
    const retry =
      existing &&
      existing.status !== "sent" &&
      Date.now() - existing.attempted_at.getTime() < 23 * 60 * 60 * 1000
    const attemptId = retry ? existing.attempt_id : crypto.randomUUID()
    const body = retry ? existing.payload : payload
    await client.query(
      `INSERT INTO invitation_email(invitation_id,attempt_id,payload,status)
      VALUES($1,$2,$3,'pending') ON CONFLICT(invitation_id) DO UPDATE
      SET attempt_id=$2,payload=$3,status='pending',provider_id=NULL,sent_at=NULL,
      attempted_at=CASE WHEN invitation_email.attempt_id=$2 THEN invitation_email.attempted_at ELSE now() END`,
      [data.id, attemptId, JSON.stringify(body)]
    )
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "content-type": "application/json",
          "Idempotency-Key": `invitation/${data.id}/${attemptId}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })
      const result = (await response.json()) as { id?: string }
      if (!response.ok || typeof result.id !== "string")
        throw new Error("Provider did not confirm email acceptance")
      await client.query(
        "UPDATE invitation_email SET status='sent',provider_id=$2,sent_at=now() WHERE invitation_id=$1",
        [data.id, result.id]
      )
    } catch {
      await client.query(
        "UPDATE invitation_email SET status='failed' WHERE invitation_id=$1",
        [data.id]
      )
      throw new APIError("SERVICE_UNAVAILABLE", {
        message:
          "The invitation was saved, but email delivery could not be confirmed. Use Resend invitation to try again.",
      })
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        lock,
      ])
    } finally {
      client.release()
    }
  }
}
