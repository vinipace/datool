import { makeSignature } from "better-auth/crypto"
import { getAuth } from "../../lib/auth"
import { db, analyticsDb } from "../../lib/db"

try {
  const context = await getAuth().$context
  const user = await context.internalAdapter.createUser(
    {
      name: "Alert demo",
      email: "alert-demo@example.test",
      emailVerified: true,
    },
    { method: "oauth" }
  )
  const session = await context.internalAdapter.createSession(user.id)
  if (!session) throw new Error("Unable to create test session")
  const signature = await makeSignature(session.token, context.secret)
  const cookie = {
    name: context.authCookies.sessionToken.name,
    value: encodeURIComponent(`${session.token}.${signature}`),
  }
  const organization = await getAuth().api.createOrganization({
    headers: new Headers({ cookie: `${cookie.name}=${cookie.value}` }),
    body: { name: "Alert proof", slug: "alert-proof" },
  })
  if (!organization) throw new Error("Unable to create test organization")
  const projectId = process.env.DATOOL_PROJECT_ID!
  await db.query(
    "INSERT INTO project(id,organization_id,name,slug) VALUES($1,$2,'Alerts end-to-end','alerts-e2e')",
    [projectId, organization.id]
  )
  await db.query('UPDATE session SET "activeOrganizationId"=$1 WHERE id=$2', [
    organization.id,
    session.id,
  ])
  console.log(JSON.stringify({ cookie, projectId }))
} finally {
  await db.end()
  await analyticsDb.end()
}
