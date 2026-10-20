import { strict as assert } from "node:assert"
import { makeSignature } from "better-auth/crypto"
import { getAuth } from "../../lib/auth"
import { db, analyticsDb } from "../../lib/db"

import {
  GET,
  POST,
  PATCH,
} from "../../app/api/organizations/[organizationId]/teams/route"

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
  // No projects are created: team management is an organization capability.
  const call = (
    method: "GET" | "POST" | "PATCH",
    cookie: string,
    body?: unknown,
    organizationId = organization.id,
    origin = base
  ) => {
    const request = new Request(
      `${base}/api/organizations/${organizationId}/teams`,
      {
        method,
        headers: { cookie, origin, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }
    )
    return { GET, POST, PATCH }[method](request, {
      params: Promise.resolve({ organizationId }),
    })
  }
  assert.equal((await call("GET", "")).status, 401)
  assert.equal((await call("GET", outsider.cookie)).status, 403)
  assert.equal(
    (await call("GET", owner.cookie, undefined, other.id)).status,
    403
  )
  const initial = await (await call("GET", member.cookie)).json()
  assert.equal(initial.canManage, false)
  assert.deepEqual(initial.teams, [])
  assert.deepEqual(
    initial.members.map((person: { id: string }) => person.id).sort(),
    [owner.id, admin.id, member.id].sort()
  )
  assert(
    initial.members.every(
      (person: { name: string; image: unknown }) =>
        person.name && "image" in person
    )
  )
  for (const cookie of [member.cookie, outsider.cookie, ""]) {
    assert.equal(
      (await call("POST", cookie, { name: "Denied" })).status,
      cookie ? 403 : 401
    )
  }
  assert.equal(
    (
      await call(
        "POST",
        owner.cookie,
        { name: "Denied" },
        organization.id,
        "https://outside.example"
      )
    ).status,
    403
  )
  const created = await call("POST", owner.cookie, {
    name: "Support",
    memberIds: [member.id, admin.id],
  })
  assert.equal(created.status, 201)
  const { team } = await created.json()
  assert.equal(team.organizationId, organization.id)
  assert.equal(team.memberCount, 2)
  assert.equal(
    (await call("POST", owner.cookie, { name: "support" })).status,
    409
  )
  assert.equal(
    (
      await call("POST", owner.cookie, {
        name: "Invalid",
        memberIds: [outsider.id],
      })
    ).status,
    400
  )
  assert.equal((await call("POST", owner.cookie, { name: "  " })).status, 400)
  assert.equal(
    (
      await call(
        "PATCH",
        outsider.cookie,
        { id: team.id, name: "Hijacked" },
        other.id
      )
    ).status,
    404
  )
  assert.equal(
    (await call("PATCH", member.cookie, { id: team.id, memberIds: [] })).status,
    403
  )
  assert.equal(
    (
      await call("PATCH", owner.cookie, {
        id: team.id,
        memberIds: [outsider.id],
        name: "Rollback",
      })
    ).status,
    400
  )
  const renamed = await call("PATCH", admin.cookie, {
    id: team.id,
    name: "Customer care",
    description: "Order help",
    memberIds: [owner.id],
    enabled: false,
  })
  assert.equal(renamed.status, 200)
  const persisted = (await (await call("GET", owner.cookie)).json()).teams
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].name, "Customer care")
  assert.equal(persisted[0].description, "Order help")
  assert.deepEqual(persisted[0].memberIds, [owner.id])
  assert.equal(persisted[0].enabled, false)
  assert.equal(
    (await call("POST", owner.cookie, { name: "Sales" })).status,
    201
  )
  assert.equal(
    (await call("PATCH", owner.cookie, { id: team.id, name: "sales" })).status,
    409
  )
  assert.equal(
    (
      await call("PATCH", owner.cookie, {
        id: team.id,
        memberIds: [],
        enabled: true,
      })
    ).status,
    200
  )
  const restored = (await (await call("GET", owner.cookie)).json()).teams.find(
    (value: { id: string }) => value.id === team.id
  )
  assert.deepEqual(restored.memberIds, [])
  assert.equal(restored.enabled, true)
  assert.equal(restored.name, "Customer care")
  assert.deepEqual(
    (await (await call("GET", outsider.cookie, undefined, other.id)).json())
      .teams,
    []
  )
  console.log(
    "PASS organization teams persistence, permissions, validation, and CSRF"
  )
} finally {
  await analyticsDb.end()
  await db.end()
}
