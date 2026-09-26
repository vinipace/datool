import { strict as assert } from "node:assert"
import { makeSignature } from "better-auth/crypto"
import { getAuth } from "../../lib/auth"
import { db } from "../../lib/db"
import { GET } from "../../app/api/organizations/[organizationId]/projects/route"
import {
  getOrganizationEntryProject,
  getProjectByOrganizationSlug,
} from "../../lib/project-access"

try {
  const context = await getAuth().$context
  const user = await context.internalAdapter.createUser(
    {
      name: "Project owner",
      email: "projects@example.test",
      emailVerified: true,
    },
    { method: "oauth" }
  )
  const session = await context.internalAdapter.createSession(user.id)
  assert(session)
  const signature = await makeSignature(session.token, context.secret)
  const cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`
  const headers = new Headers({ cookie })
  const organization = await getAuth().api.createOrganization({
    headers,
    body: { name: "Workspace", slug: "workspace" },
  })
  assert(organization)
  assert.equal(await getOrganizationEntryProject(organization.id), null)
  await db.query(
    `INSERT INTO organization (id, name, slug, "createdAt") VALUES ('other-org', 'Other', 'other', NOW())`
  )
  await db.query(
    `INSERT INTO project (id, organization_id, name, slug, created_at) VALUES
    ('first', $1, 'Alpha 100%', 'alpha', '2026-09-01'), ('second', $1, 'Beta', 'beta', '2026-09-02'), ('outside', 'other-org', 'Alpha private', 'alpha-private', '2026-09-01'), ('duplicate-slug', 'other-org', 'Duplicate Alpha', 'alpha', '2026-09-02')`,
    [organization.id]
  )
  assert.equal(
    (await getOrganizationEntryProject(organization.id))?.id,
    "first"
  )
  assert.equal((await getOrganizationEntryProject("other-org"))?.id, "outside")
  assert.equal(await getOrganizationEntryProject("missing-org"), null)
  assert.equal(
    (await getProjectByOrganizationSlug("alpha", organization.id))?.id,
    "first"
  )
  assert.equal(
    (await getProjectByOrganizationSlug("alpha", "other-org"))?.id,
    "duplicate-slug"
  )
  await db.query(
    `INSERT INTO traces (id, project_id, name, operation, status, started_at) VALUES ('t1', 'first', 'Trace', 'test', 'completed', '2026-09-10'), ('t2', 'outside', 'Private', 'test', 'completed', '2026-09-10')`
  )
  await db.query(
    `INSERT INTO eval_runs (id, project_id, status, created_at) VALUES ('e1', 'first', 'completed', '2026-09-10'), ('e2', 'first', 'completed', '2026-09-10')`
  )
  await db.query(
    `INSERT INTO datasets (id, project_id, name, created_at, updated_at) VALUES ('d1', 'first', 'Dataset', '2026-09-10', '2026-09-10')`
  )
  const request = (
    query: string,
    organizationId = organization.id,
    authenticated = true
  ) =>
    GET(
      new Request(
        `http://localhost:3000/api/organizations/${organizationId}/projects?${query}`,
        { headers: authenticated ? headers : undefined }
      ),
      { params: Promise.resolve({ organizationId }) }
    )

  const firstPage = await (await request("pageSize=1&includeStats=true")).json()
  const secondPage = await (
    await request("pageSize=1&page=2&includeStats=true")
  ).json()
  assert.equal(firstPage.total, 2)
  assert.equal(firstPage.projects.length, 1)
  assert.notEqual(firstPage.projects[0].id, secondPage.projects[0].id)
  const search = await (await request("q=ALPHA&includeStats=true")).json()
  assert.equal(search.total, 1)
  assert.equal(search.projects[0].id, "first")
  assert.equal(search.projects[0].traceCount, 1)
  assert.equal(search.projects[0].evalCount, 2)
  assert.equal(search.projects[0].datasetCount, 1)
  const literal = await (await request("q=%25")).json()
  assert.equal(literal.total, 1)
  assert.equal(literal.projects[0].traceCount, undefined)
  const empty = await (await request("q=missing")).json()
  assert.equal(empty.total, 0)
  assert.deepEqual(empty.projects, [])
  const zero = await (await request("q=beta&includeStats=true")).json()
  assert.equal(zero.projects[0].traceCount, 0)
  assert.equal((await request("", "other-org")).status, 403)
  assert.equal((await request("", organization.id, false)).status, 401)
  assert.equal((await request(`q=${"x".repeat(121)}`)).status, 400)
  console.log("PASS project search, pagination, counts, and tenant isolation")
} finally {
  await db.end()
}
