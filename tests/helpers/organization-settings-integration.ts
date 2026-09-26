import { strict as assert } from "node:assert"
import { makeSignature } from "better-auth/crypto"
import { getAuth } from "../../lib/auth"
import { db, analyticsDb } from "../../lib/db"

const base = process.env.BETTER_AUTH_URL!
const auth = getAuth()
try {
  const context = await auth.$context
  async function account(role: string) {
    const user = await context.internalAdapter.createUser(
      { name: role, email: `${role}@example.test`, emailVerified: true },
      { method: "oauth" }
    )
    const session = await context.internalAdapter.createSession(user.id)
    assert(session)
    const signature = await makeSignature(session.token, context.secret)
    return {
      id: user.id,
      cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`,
    }
  }
  const owner = await account("owner")
  const admin = await account("admin")
  const member = await account("member")
  const outsider = await account("outsider")
  const organization = await auth.api.createOrganization({
    headers: new Headers({ cookie: owner.cookie }),
    body: { name: "Original", slug: "original" },
  })
  assert(organization)
  for (const [user, role] of [
    [admin, "admin"],
    [member, "member"],
  ] as const) {
    await db.query(
      'INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,$4,NOW())',
      [crypto.randomUUID(), organization.id, user.id, role]
    )
  }
  const other = await auth.api.createOrganization({
    headers: new Headers({ cookie: outsider.cookie }),
    body: { name: "Other", slug: "taken-slug" },
  })
  assert(other)
  const update = (
    cookie: string,
    data: unknown,
    organizationId = organization.id,
    origin = base
  ) =>
    auth.handler(
      new Request(`${base}/api/auth/organization/update`, {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: JSON.stringify({ organizationId, data }),
      })
    )
  const ownerSaved = await update(owner.cookie, {
    name: "  Renamed organization  ",
    slug: "renamed-org",
  })
  assert.equal(ownerSaved.status, 200)
  assert.equal((await ownerSaved.json()).name, "Renamed organization")
  const adminSaved = await update(admin.cookie, { name: "Admin update" })
  assert.equal(adminSaved.status, 200)
  const stored = (
    await db.query("SELECT id,name,slug FROM organization WHERE id=$1", [
      organization.id,
    ])
  ).rows[0]
  assert.deepEqual(stored, {
    id: organization.id,
    name: "Admin update",
    slug: "renamed-org",
  })
  assert.equal((await update(member.cookie, { name: "Denied" })).status, 403)
  assert.equal((await update("", { name: "Denied" })).status, 401)
  assert.equal(
    (
      await update(
        owner.cookie,
        { name: "Denied" },
        organization.id,
        "https://outside.example"
      )
    ).status,
    403
  )
  assert(!(await update(outsider.cookie, { name: "Denied" })).ok)
  assert(!(await update(owner.cookie, { name: "Denied" }, other.id)).ok)
  for (const data of [
    { name: "   " },
    { name: "x".repeat(161) },
    { slug: "bad slug" },
    { slug: "UPPER" },
    { slug: "bad--slug" },
    { slug: "x".repeat(121) },
    { slug: "taken-slug" },
  ]) {
    assert.equal(
      (await update(owner.cookie, data)).status,
      400,
      JSON.stringify(data)
    )
  }
  assert.deepEqual(
    (
      await db.query("SELECT id,name,slug FROM organization WHERE id=$1", [
        organization.id,
      ])
    ).rows[0],
    stored
  )
  assert.equal(
    (await db.query("SELECT name FROM organization WHERE id=$1", [other.id]))
      .rows[0].name,
    "Other"
  )
  console.log(
    "PASS organization settings persistence, permissions, validation, and CSRF"
  )
} finally {
  await analyticsDb.end()
  await db.end()
}
