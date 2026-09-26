import { makeSignature } from "better-auth/crypto"
import { getAuth } from "../../lib/auth"
import { db, analyticsDb } from "../../lib/db"
import { createOrganizationKey } from "../../src/server/auth/key-management"
try {
  const auth = getAuth()
  const context = await auth.$context
  async function person(name: string) {
    const user = await context.internalAdapter.createUser(
      {
        name,
        email: `${name.toLowerCase()}@example.test`,
        emailVerified: true,
      },
      { method: "oauth" }
    )
    const session = await context.internalAdapter.createSession(user.id)
    if (!session) throw new Error("Unable to create session")
    return {
      user,
      session,
      cookie: {
        name: context.authCookies.sessionToken.name,
        value: encodeURIComponent(
          `${session.token}.${await makeSignature(session.token, context.secret)}`
        ),
      },
    }
  }
  const owner = await person("Author"),
    member = await person("Teammate")
  const headers = new Headers({
    cookie: `${owner.cookie.name}=${owner.cookie.value}`,
    origin: process.env.BETTER_AUTH_URL!,
  })
  const organization = await auth.api.createOrganization({
    headers,
    body: { name: "Views proof", slug: "views-proof" },
  })
  if (!organization) throw new Error("Unable to create organization")
  await db.query(
    'INSERT INTO member(id,"organizationId","userId",role,"createdAt") VALUES($1,$2,$3,\'member\',now())',
    [crypto.randomUUID(), organization.id, member.user.id]
  )
  const projectId = process.env.DATOOL_PROJECT_ID!,
    otherProjectId = crypto.randomUUID()
  await db.query(
    "INSERT INTO project(id,organization_id,name,slug) VALUES($1,$2,'Views E2E','views-e2e'),($3,$2,'Other project','views-other')",
    [projectId, organization.id, otherProjectId]
  )
  await db.query(
    'UPDATE session SET "activeOrganizationId"=$1 WHERE id=ANY($2)',
    [organization.id, [owner.session.id, member.session.id]]
  )
  for (const [id, name, operation, output] of [
    [
      "view-source",
      "Original answer",
      "answer",
      { answer: "Hello from source" },
    ],
    [
      "view-other",
      "Different operation",
      "summarize",
      { answer: "Hello from another trace" },
    ],
    ["view-mismatch", "Different shape", "answer", { messages: ["hello"] }],
  ] as const) {
    await db.query(
      "INSERT INTO traces(id,project_id,name,operation,status,started_at,ended_at,input_json,output_json,group_type,group_name,group_version) VALUES($1,$2,$3,$4,'completed',now(),now(),'{\"question\":\"Hello?\"}',$5,'agent','Support','v1')",
      [id, projectId, name, operation, JSON.stringify(output)]
    )
  }
  await db.query(
    "INSERT INTO datasets(id,project_id,name,created_at,updated_at) VALUES('view-dataset',$1,'Answer examples',now(),now())",
    [projectId]
  )
  await db.query(
    "INSERT INTO dataset_items(id,project_id,dataset_id,input_json,expected_output_json,metadata_json,source_trace_id,created_at,updated_at) VALUES('view-row',$1,'view-dataset','{\"question\":\"Expected?\"}','{\"answer\":\"Expected dataset answer\"}','{\"locale\":\"en\"}','view-source',now(),now())",
    [projectId]
  )
  const key = await createOrganizationKey(
    new Request(
      `${process.env.BETTER_AUTH_URL}/api/organizations/${organization.id}/keys`,
      { headers }
    ),
    organization.id,
    { name: "View reader", scopes: ["views:read"] }
  )
  console.log(
    JSON.stringify({
      owner: owner.cookie,
      member: member.cookie,
      projectId,
      otherProjectId,
      readKey: key.key,
    })
  )
} finally {
  await db.end()
  await analyticsDb.end()
}
