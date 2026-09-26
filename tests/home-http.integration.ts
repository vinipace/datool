import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import nextEnv from "@next/env"
import { makeSignature } from "better-auth/crypto"
import { assertLocalCMSDatabase } from "../scripts/cms-local-database"

nextEnv.loadEnvConfig(process.cwd())
assertLocalCMSDatabase(process.env.DATABASE_URL)
const base = process.env.CMS_TEST_URL || process.env.BETTER_AUTH_URL
assert(
  base && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname)
)
const { getAuth } = await import("../lib/auth")
const { db, analyticsDb } = await import("../lib/db")
const organizationIDs = [randomUUID(), randomUUID(), randomUUID()]
const suffix = randomUUID()
let userID: string | undefined

async function request(path = "/", cookie = "") {
  const response: Response = await fetch(new URL(path, base), {
    redirect: "manual",
    headers: { cookie },
  })
  return { response, body: await response.text() }
}

async function expectLanding(cookie = "") {
  const { response, body } = await request("/", cookie)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("location"), null)
  assert.ok(body.includes("See what your AI is doing."))
  assert.ok(body.includes("<title>Understand and improve your AI"))
  const canonical = new URL("/", base).href
  assert.ok(body.includes(`rel="canonical" href="${canonical}"`))
  assert.ok(body.includes(`property="og:url" content="${canonical}"`))
  assert.ok(body.includes('name="robots" content="index, follow"'))
  assert.ok(!body.includes("NEXT_REDIRECT"))
  assert.ok(!body.includes("Choose an organization"))
  assert.match(response.headers.get("cache-control") ?? "", /no-store|no-cache/)
}

try {
  await expectLanding()
  await expectLanding("better-auth.session_token=invalid-session")
  const context = await getAuth().$context
  const user = await context.internalAdapter.createUser(
    {
      name: "Home routing fixture",
      email: `home-${suffix}@example.test`,
      emailVerified: true,
    },
    { method: "oauth" }
  )
  userID = user.id
  for (const [index, id] of organizationIDs.entries()) {
    await db.query(
      `INSERT INTO organization (id, name, slug, "createdAt") VALUES ($1, $2, $3, NOW())`,
      [id, `Home fixture ${index}`, `home-${index}-${suffix}`]
    )
    if (index < 2) {
      await db.query(
        `INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, 'owner', NOW())`,
        [randomUUID(), id, user.id]
      )
    }
  }
  const projectSlug = `home-first-${suffix}`
  await db.query(
    `INSERT INTO project (id, organization_id, name, slug, created_at) VALUES
     ($1, $2, 'First project', $3, '2026-01-01'),
     ($4, $2, 'Later project', $5, '2026-01-02')`,
    [
      randomUUID(),
      organizationIDs[0],
      projectSlug,
      randomUUID(),
      `home-later-${suffix}`,
    ]
  )
  async function sessionCookie(
    activeOrganizationID: string | null,
    expired = false
  ) {
    const session = await context.internalAdapter.createSession(user.id)
    assert(session)
    await db.query(
      `UPDATE session SET "activeOrganizationId" = $1, "expiresAt" = $2 WHERE id = $3`,
      [
        activeOrganizationID,
        new Date(Date.now() + (expired ? -60_000 : 3_600_000)),
        session.id,
      ]
    )
    const signature = await makeSignature(session.token, context.secret)
    return `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`
  }
  await expectLanding(await sessionCookie(organizationIDs[0], true))

  const memberCookie = await sessionCookie(organizationIDs[0])
  const active = await request("/", memberCookie)
  assert.equal(active.response.status, 307)
  assert.equal(
    active.response.headers.get("location"),
    `/p/${projectSlug}/traces`
  )
  const empty = await request("/", await sessionCookie(organizationIDs[1]))
  assert.equal(empty.response.status, 307)
  assert.equal(empty.response.headers.get("location"), "/projects")
  for (const cookie of [
    await sessionCookie(null),
    await sessionCookie(organizationIDs[2]),
  ]) {
    const picker = await request("/", cookie)
    assert.equal(picker.response.status, 200)
    assert.equal(picker.response.headers.get("location"), null)
    assert.ok(picker.body.includes("Home fixture 0"))
    assert.ok(!picker.body.includes("Home fixture 2"))
    assert.ok(!picker.body.includes("See what your AI is doing."))
  }
  const selection = await request("/?returnTo=%2Fprojects", memberCookie)
  assert.equal(selection.response.status, 200)
  assert.ok(selection.body.includes("Home fixture 0"))
  const publicAlias = await request("/landing-page", memberCookie)
  assert.equal(publicAlias.response.status, 200)
  assert.ok(publicAlias.body.includes("See what your AI is doing."))
  // A subsequent anonymous request must not reuse the signed-in response.
  await expectLanding()
  console.log(
    "PASS anonymous/invalid/expired sessions render landing; signed-in active project, empty organization, picker, membership, returnTo and public alias behavior are preserved."
  )
} finally {
  await db.query("DELETE FROM organization WHERE id = ANY($1::text[])", [
    organizationIDs,
  ])
  if (userID) await db.query('DELETE FROM "user" WHERE id = $1', [userID])
  await analyticsDb.end()
  await db.end()
}
