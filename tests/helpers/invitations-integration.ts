import { strict as assert } from "node:assert"
import { makeSignature } from "better-auth/crypto"
import { getAuth } from "../../lib/auth"
import { db, analyticsDb } from "../../lib/db"
import { GET as members } from "../../app/api/organizations/[organizationId]/members/route"
import { hasInvitationSignInAccess } from "../../src/server/auth/invitation-access"

const auth = getAuth()
const context = await auth.$context
const sent: {
  key: string
  body: { to: string[]; html: string; text: string }
}[] = []
const originalFetch = globalThis.fetch
let fail = false
globalThis.fetch = (async (url, init) => {
  assert.equal(String(url), "https://api.resend.com/emails")
  sent.push({
    key: new Headers(init?.headers).get("Idempotency-Key")!,
    body: JSON.parse(String(init?.body)),
  })
  if (fail) throw new Error("Uncertain network failure with private details")
  return Response.json({ id: `mail_${sent.length}` })
}) as typeof fetch

async function user(
  name: string,
  email = `${name}@example.test`,
  verified = true
) {
  const user = await context.internalAdapter.createUser(
    { name, email, emailVerified: verified },
    { method: "oauth" }
  )
  const session = await context.internalAdapter.createSession(user.id)
  assert(session)
  const signature = await makeSignature(session.token, context.secret)
  return {
    user,
    cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`,
  }
}
async function post(
  path: string,
  body: unknown,
  cookie: string,
  origin = "http://localhost:3000"
) {
  return auth.handler(
    new Request(`http://localhost:3000/api/auth/organization/${path}`, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  )
}
const owner = await user("Owner <script>alert(1)</script>")
const manager = await user("manager"),
  reader = await user("reader"),
  outsider = await user("outsider")
try {
  const org = await auth.api.createOrganization({
    headers: new Headers({ cookie: owner.cookie }),
    body: { name: "Team <b>safe</b>", slug: "invitations" },
  })
  assert(org)
  for (const [person, role] of [
    [manager, "admin"],
    [reader, "member"],
  ] as const)
    await db.query(
      'INSERT INTO member(id,"organizationId","userId",role,"createdAt") VALUES($1,$2,$3,$4,now())',
      [crypto.randomUUID(), org.id, person.user.id, role]
    )
  const body = {
    organizationId: org.id,
    email: "invited@external.test",
    role: "member",
  }
  assert.equal((await post("invite-member", body, reader.cookie)).status, 403)
  assert.equal((await post("invite-member", body, outsider.cookie)).status, 400)
  assert.equal(
    (await post("invite-member", body, owner.cookie, "https://evil.test"))
      .status,
    403
  )
  assert.equal(sent.length, 0)
  assert.equal(
    (await post("invite-member", { ...body, role: "owner" }, manager.cookie))
      .status,
    403
  )
  const created = await post("invite-member", body, owner.cookie)
  assert.equal(created.status, 200)
  const invitation = await created.json()
  assert.equal(sent.length, 1)
  assert(sent[0].body.html.includes("Team &lt;b&gt;safe&lt;/b&gt;"))
  assert(!sent[0].body.html.includes("<script>"))
  assert(
    sent[0].body.text.includes(`http://localhost:3000/invite/${invitation.id}`)
  )
  assert.equal((await post("invite-member", body, owner.cookie)).status, 400)
  assert.equal(
    (await post("invite-member", { ...body, resend: true }, owner.cookie))
      .status,
    429
  )
  assert.equal(sent.length, 1)
  const list = (cookie: string) =>
    members(
      new Request("http://localhost:3000/api/members", { headers: { cookie } }),
      { params: Promise.resolve({ organizationId: org.id }) }
    )
  assert.equal((await list("")).status, 401)
  assert.equal((await list(outsider.cookie)).status, 403)
  const ownerList = await (await list(owner.cookie)).json()
  assert.equal(ownerList.invitations[0].emailStatus, "sent")
  assert.equal((await (await list(reader.cookie)).json()).invitations.length, 0)
  assert.equal(
    (
      await post(
        "accept-invitation",
        { invitationId: invitation.id },
        outsider.cookie
      )
    ).status,
    403
  )
  const unverified = await user("unverified", body.email, false)
  assert.equal(
    (
      await post(
        "accept-invitation",
        { invitationId: invitation.id },
        unverified.cookie
      )
    ).status,
    403
  )
  // Remove just this disposable unverified account, then exercise real Google
  // callback persistence with only the external token exchange replaced.
  await db.query('DELETE FROM "user" WHERE id=$1', [unverified.user.id])
  assert(
    await hasInvitationSignInAccess(db, {
      email: body.email,
      emailVerified: true,
    })
  )
  assert.equal(
    await hasInvitationSignInAccess(db, {
      email: body.email,
      emailVerified: false,
    }),
    false
  )
  const google = context.socialProviders.find(
    (provider) => provider.id === "google"
  )!
  google.validateAuthorizationCode = async () => ({
    idToken: `e30.${Buffer.from(JSON.stringify({ sub: "invited-google", email: body.email, email_verified: true, name: "Invited teammate" })).toString("base64url")}.signature`,
  })
  const signIn = await auth.handler(
    new Request("http://localhost:3000/api/auth/sign-in/social", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider: "google",
        callbackURL: `/invite/${invitation.id}`,
        disableRedirect: true,
      }),
    })
  )
  const state = new URL((await signIn.json()).url).searchParams.get("state")!
  const cookies = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ")
  const callback = await auth.handler(
    new Request(
      `http://localhost:3000/api/auth/callback/google?code=fixture&state=${encodeURIComponent(state)}`,
      { headers: { cookie: cookies(signIn) } }
    )
  )
  assert.equal(callback.status, 302)
  assert.equal(callback.headers.get("location"), `/invite/${invitation.id}`)
  const invitedCookie = cookies(callback)
  const invitedSession = await auth.api.getSession({
    headers: new Headers({ cookie: invitedCookie }),
  })
  assert(invitedSession?.user.emailVerified)
  const accepted = await post(
    "accept-invitation",
    { invitationId: invitation.id },
    invitedCookie
  )
  assert.equal(accepted.status, 200)
  const membership = (await accepted.json()).member
  assert.equal(membership.organizationId, org.id)
  assert.equal(
    (
      await post(
        "accept-invitation",
        { invitationId: invitation.id },
        invitedCookie
      )
    ).status,
    400
  )
  assert.equal((await list(invitedCookie)).status, 200)
  assert(
    await hasInvitationSignInAccess(db, {
      email: body.email,
      emailVerified: true,
    })
  )
  assert.equal(
    (
      await post(
        "update-member-role",
        { organizationId: org.id, memberId: membership.id, role: "admin" },
        owner.cookie
      )
    ).status,
    200
  )
  assert.equal(
    (
      await post(
        "remove-member",
        { organizationId: org.id, memberIdOrEmail: membership.id },
        reader.cookie
      )
    ).status,
    401
  )
  assert.equal(
    (
      await post(
        "remove-member",
        { organizationId: org.id, memberIdOrEmail: membership.id },
        owner.cookie
      )
    ).status,
    200
  )
  assert.equal((await list(invitedCookie)).status, 403)
  assert.equal(
    await hasInvitationSignInAccess(db, {
      email: body.email,
      emailVerified: true,
    }),
    false
  )
  const ownerMember = (
    await db.query(
      'SELECT id FROM member WHERE "organizationId"=$1 AND "userId"=$2',
      [org.id, owner.user.id]
    )
  ).rows[0]
  assert.equal(
    (
      await post(
        "remove-member",
        { organizationId: org.id, memberIdOrEmail: ownerMember.id },
        owner.cookie
      )
    ).status,
    400
  )
  assert.equal(
    (
      await post(
        "update-member-role",
        { organizationId: org.id, memberId: ownerMember.id, role: "member" },
        owner.cookie
      )
    ).status,
    400
  )

  fail = true
  const retryBody = { ...body, email: "retry@external.test" }
  const failed = await post("invite-member", retryBody, owner.cookie)
  assert.equal(failed.status, 503)
  assert(!(await failed.text()).includes("private details"))
  const failedInvitation = (
    await db.query("SELECT id FROM invitation WHERE email=$1", [
      retryBody.email,
    ])
  ).rows[0]
  assert.equal(
    (
      await db.query(
        "SELECT status FROM invitation_email WHERE invitation_id=$1",
        [failedInvitation.id]
      )
    ).rows[0].status,
    "failed"
  )
  const firstAttempt = sent.at(-1)!
  fail = false
  assert.equal(
    (await post("invite-member", { ...retryBody, resend: true }, owner.cookie))
      .status,
    200
  )
  assert.deepEqual(
    sent.at(-1),
    firstAttempt,
    "Uncertain retries use the same provider key and exact body"
  )
  await db.query(
    "UPDATE invitation_email SET sent_at=now()-interval '2 minutes' WHERE invitation_id=$1",
    [failedInvitation.id]
  )
  assert.equal(
    (await post("invite-member", { ...retryBody, resend: true }, owner.cookie))
      .status,
    200
  )
  assert.notEqual(sent.at(-1)!.key, firstAttempt.key)
  await db.query(
    "UPDATE invitation SET \"expiresAt\"=now()-interval '1 second' WHERE id=$1",
    [failedInvitation.id]
  )
  const recipient = await user("retry", retryBody.email)
  assert.equal(
    (
      await post(
        "accept-invitation",
        { invitationId: failedInvitation.id },
        recipient.cookie
      )
    ).status,
    400
  )
  const reinvited = await post(
    "invite-member",
    { ...retryBody, resend: true },
    owner.cookie
  )
  assert.equal(reinvited.status, 200)
  const replacement = await reinvited.json()
  assert.notEqual(replacement.id, failedInvitation.id)
  assert.equal(
    (
      await db.query("SELECT status FROM invitation WHERE id=$1", [
        failedInvitation.id,
      ])
    ).rows[0].status,
    "canceled"
  )
  assert.equal(
    (
      await post(
        "cancel-invitation",
        { invitationId: replacement.id },
        owner.cookie
      )
    ).status,
    200
  )
  assert.equal(
    (
      await post(
        "accept-invitation",
        { invitationId: replacement.id },
        recipient.cookie
      )
    ).status,
    400
  )
  assert.equal(
    await hasInvitationSignInAccess(db, {
      email: retryBody.email,
      emailVerified: true,
    }),
    false
  )
  const declined = await post("invite-member", retryBody, owner.cookie)
  assert.equal(declined.status, 200)
  const declinedId = (await declined.json()).id
  assert.equal(
    (
      await post(
        "reject-invitation",
        { invitationId: declinedId },
        recipient.cookie
      )
    ).status,
    200
  )
  assert.equal(
    (
      await post(
        "accept-invitation",
        { invitationId: declinedId },
        recipient.cookie
      )
    ).status,
    400
  )
  assert.equal(
    await hasInvitationSignInAccess(db, {
      email: retryBody.email,
      emailVerified: true,
    }),
    false
  )
  const fromManager = await post("invite-member", retryBody, manager.cookie)
  assert.equal(fromManager.status, 200)
  const managerInviteId = (await fromManager.json()).id
  await db.query(
    'DELETE FROM member WHERE "organizationId"=$1 AND "userId"=$2',
    [org.id, manager.user.id]
  )
  assert.equal(
    (
      await post(
        "accept-invitation",
        { invitationId: managerInviteId },
        recipient.cookie
      )
    ).status,
    400
  )
  assert.equal(
    await hasInvitationSignInAccess(db, {
      email: retryBody.email,
      emailVerified: true,
    }),
    false
  )
  delete process.env.RESEND_API_KEY
  assert.equal(
    (
      await post(
        "invite-member",
        { ...body, email: "disabled@example.test" },
        owner.cookie
      )
    ).status,
    503
  )
  assert.equal(
    (
      await db.query(
        "SELECT id FROM invitation WHERE email='disabled@example.test'"
      )
    ).rowCount,
    0
  )
  console.log(
    "PASS invitations: permissions, Google signup, email retries, expiration, acceptance, and member management"
  )
} finally {
  globalThis.fetch = originalFetch
  await analyticsDb.end()
  await db.end()
}
