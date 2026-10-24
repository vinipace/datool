import assert from "node:assert/strict"
import { makeSignature } from "better-auth/crypto"
import { getAuth } from "../../lib/auth"
import { db, analyticsDb } from "../../lib/db"
import { GET as projects } from "../../app/api/inbox-mobile/projects/route"
import { POST as register, DELETE as unregister } from "../../app/api/inbox-mobile/devices/route"

const base = process.env.BETTER_AUTH_URL!
try {
  // Exercise the same native request as the installed app. No Google request
  // is performed: the server only generates the provider authorization URL.
  const signIn = async (callbackURL: string, origin = "datool-inbox://") => {
    await db.query('delete from "rateLimit"')
    return getAuth().handler(new Request(`${base}/api/auth/sign-in/social`, {
    method: "POST", headers: { "content-type": "application/json", "expo-origin": origin, cookie: "", "x-forwarded-for": "192.0.2.10" },
    body: JSON.stringify({ provider: "google", callbackURL, disableRedirect: true }),
  }))
  }
  for (const callback of ["datool-inbox:///", "datool-inbox://auth-callback?state=fixture", "/"]) {
    const response = await signIn(callback)
    assert.equal(response.status, 200, `Native callback rejected: ${callback}: ${await response.clone().text()}`)
    const authorization = new URL((await response.json()).url)
    assert.equal(authorization.origin, "https://accounts.google.com")
    assert.equal(authorization.searchParams.get("redirect_uri"), `${base}/api/auth/callback/google`)
  }
  for (const callback of ["https://untrusted.example/", "other-app://", "datool-inbox-evil://"]) {
    const response = await signIn(callback)
    assert.equal(response.status, 403)
    assert.equal((await response.json()).code, "INVALID_CALLBACK_URL")
  }
  const foreignOrigin = await signIn("datool-inbox:///", "other-app://")
  assert.equal(foreignOrigin.status, 403)
  console.log("PASS native callback accepted while foreign callbacks and origins remain rejected")
  const auth = await getAuth().$context
  const user = await auth.internalAdapter.createUser({ name: "Operator", email: "operator@example.test", emailVerified: true }, { method: "oauth" })
  const session = await auth.internalAdapter.createSession(user.id)
  assert(session)
  const signature = await makeSignature(session.token, auth.secret)
  const cookie = `${auth.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`
  const organizationId = crypto.randomUUID(), projectId = crypto.randomUUID(), foreignProject = crypto.randomUUID()
  await db.query(`insert into organization(id,name,slug,"createdAt") values ($1,'Support','support',now()),('foreign','Foreign','foreign',now())`, [organizationId])
  await db.query(`insert into project(id,organization_id,name,slug) values ($1,$2,'Support','support'),($3,'foreign','Foreign','foreign')`, [projectId, organizationId, foreignProject])
  await db.query(`insert into member(id,"organizationId","userId",role,"createdAt") values ($1,$2,$3,'member',now())`, [crypto.randomUUID(), organizationId, user.id])
  process.env.DATOOL_BUILD_ENABLED = "false"
  process.env.DATOOL_BUILD_ORGANIZATION_IDS = "another-organization"
  const disabled = await projects(new Request(`${base}/api/inbox-mobile/projects`, { headers: { cookie } }))
  assert.deepEqual((await disabled.json()).data.items, [])
  process.env.DATOOL_BUILD_ORGANIZATION_IDS = organizationId
  const installationId = crypto.randomUUID()
  const body = { installationId, token: `ExpoPushToken[${crypto.randomUUID()}]` }
  const request = (project: string, origin = base, credentials = cookie) => new Request(`${base}/api/inbox-mobile/devices`, { method: "POST", headers: { origin, cookie: credentials, "x-project-id": project, "content-type": "application/json" }, body: JSON.stringify(body) })
  assert.equal((await projects(new Request(`${base}/api/inbox-mobile/projects`))).status, 401)
  const list = await projects(new Request(`${base}/api/inbox-mobile/projects`, { headers: { cookie } }))
  assert.deepEqual((await list.json()).data.items.map((p: { id: string }) => p.id), [projectId])
  assert.equal((await register(request(projectId, base, ""))).status, 401)
  assert.equal((await register(request(projectId, "https://untrusted.example"))).status, 403)
  assert.equal((await register(request(foreignProject))).status, 403)
  assert.equal((await register(request(projectId))).status, 200)
  assert.equal((await db.query('select user_id from inbox_mobile_devices')).rows[0].user_id, user.id)
  await db.query('delete from member where "userId"=$1', [user.id])
  assert.equal((await register(request(projectId))).status, 403)
  const removed = await unregister(new Request(`${base}/api/inbox-mobile/devices`, { method: "DELETE", headers: { origin: base, cookie, "content-type": "application/json" }, body: JSON.stringify({ installationId }) }))
  assert.equal(removed.status, 200)
  assert.equal((await db.query('select id from inbox_mobile_devices')).rowCount, 0)
  console.log("PASS mobile routes enforce session, origin, membership, project isolation and owner-only unsubscribe")
} finally { await Promise.all([db.end(), analyticsDb.end()]) }
