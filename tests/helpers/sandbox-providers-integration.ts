import { strict as assert } from "node:assert"
import { makeSignature } from "better-auth/crypto"
import { Effect } from "effect"
import { getAuth } from "../../lib/auth"
import { db } from "../../lib/db"
import {
  GET,
  PUT,
  PATCH,
  DELETE,
} from "../../app/api/projects/[projectId]/sandbox-providers/route"
import { POST as testScorer } from "../../app/api/scorers/test/route"
import { getSandboxExecutionProviders } from "../../src/server/sandbox/providers-store"
import { defaultScorer } from "../../src/lib/tracer/scorers"
import { createTestTracerService } from "../../src/server/tracer/service"

try {
  const auth = await getAuth().$context
  async function userSession(name: string) {
    const user = await auth.internalAdapter.createUser(
      { name, email: `${name}@example.test`, emailVerified: true },
      { method: "oauth" }
    )
    const session = await auth.internalAdapter.createSession(user.id)
    assert(session)
    return {
      user,
      cookie: `${auth.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${await makeSignature(session.token, auth.secret)}`)}`,
    }
  }
  const owner = await userSession("sandbox-owner")
  const member = await userSession("sandbox-member")
  const outsider = await userSession("sandbox-outsider")
  const org = await getAuth().api.createOrganization({
    headers: new Headers({ cookie: owner.cookie }),
    body: { name: "Sandbox test", slug: "sandbox-test" },
  })
  assert(org)
  await db.query(
    `INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ('member', $1, $2, 'member', now())`,
    [org.id, member.user.id]
  )
  await db.query(
    "INSERT INTO project (id, organization_id, name, slug) VALUES ('a', $1, 'A', 'a'), ('b', $1, 'B', 'b')",
    [org.id]
  )
  const context = (projectId = "a") => ({
    params: Promise.resolve({ projectId }),
  })
  const request = (
    method: string,
    body?: unknown,
    cookie = owner.cookie,
    origin = "http://localhost:3000"
  ) =>
    new Request("http://localhost:3000/api/projects/a/sandbox-providers", {
      method,
      headers: { cookie, origin, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  const settings = async (project = "a") =>
    (await GET(request("GET"), context(project))).json()
  const vercel = {
    provider: "vercel",
    apiKey: "sandbox-secret-a",
    teamId: "team_test",
    projectId: "prj_test",
  }
  const modal = {
    provider: "modal",
    tokenId: "modal-id",
    tokenSecret: "modal-secret",
  }
  assert.equal(
    (await GET(request("GET", undefined, ""), context())).status,
    401
  )
  assert.equal(
    (await GET(request("GET", undefined, outsider.cookie), context())).status,
    403
  )
  for (const [method, route] of [
    ["PUT", PUT],
    ["PATCH", PATCH],
    ["DELETE", DELETE],
  ] as const) {
    assert.equal(
      (await route(request(method, vercel, member.cookie), context())).status,
      403
    )
    assert.equal(
      (
        await route(
          request(method, vercel, owner.cookie, "https://evil.example"),
          context()
        )
      ).status,
      403
    )
  }
  assert.equal(
    (await GET(request("GET", undefined, member.cookie), context())).status,
    200
  )
  assert.deepEqual((await settings()).executionOrder, ["local"])
  assert.equal(
    (await PATCH(request("PATCH", { provider: "vercel" }), context())).status,
    400
  )
  assert.equal(
    (await PUT(request("PUT", { provider: "modal", tokenId: "id" }), context()))
      .status,
    400
  )
  assert.equal(
    (
      await PUT(
        request("PUT", { ...vercel, apiKey: "x".repeat(17000) }),
        context()
      )
    ).status,
    413
  )
  assert.equal((await PUT(request("PUT", vercel), context())).status, 200)
  assert.equal((await PUT(request("PUT", modal), context())).status, 200)
  assert.equal(
    (await PATCH(request("PATCH", { provider: "vercel" }), context())).status,
    200
  )
  assert.deepEqual((await settings()).executionOrder, [
    "vercel",
    "local",
    "modal",
  ])
  assert.deepEqual((await settings("b")).executionOrder, ["local"])
  const stored = await db.query(
    "SELECT providers::text FROM project_sandbox_settings WHERE project_id = 'a'"
  )
  for (const secret of [vercel.apiKey, modal.tokenId, modal.tokenSecret]) {
    assert(!stored.rows[0].providers.includes(secret))
    assert(!JSON.stringify(await settings()).includes(secret))
  }
  assert.equal(
    (
      await PUT(
        request("PUT", {
          provider: "vercel",
          teamId: "team_new",
          projectId: "prj_new",
        }),
        context()
      )
    ).status,
    200
  )
  const saved = (await getSandboxExecutionProviders("a"))[0].credentials()
  assert.equal(saved.provider, "vercel")
  assert(
    saved.provider === "vercel" &&
      saved.apiKey === vercel.apiKey &&
      saved.teamId === "team_new"
  )
  assert.equal(
    (await PUT(request("PUT", { ...vercel, apiKey: "replacement" }), context()))
      .status,
    200
  )
  // Copying ciphertext to another project cannot unlock it.
  await db.query(
    "INSERT INTO project_sandbox_settings (project_id, providers, default_provider) SELECT 'b', providers, default_provider FROM project_sandbox_settings WHERE project_id = 'a'"
  )
  const copied = await getSandboxExecutionProviders("b")
  assert.throws(() => copied[0].credentials(), /Unable to unlock/)
  await db.query("DELETE FROM project_sandbox_settings WHERE project_id = 'b'")
  await DELETE(request("DELETE", { provider: "vercel" }), context())
  assert.equal((await settings()).defaultProvider, "local")
  await DELETE(request("DELETE", { provider: "modal" }), context())
  await DELETE(request("DELETE", { provider: "local" }), context())
  assert.equal((await settings()).defaultProvider, null)
  assert.deepEqual((await settings()).executionOrder, [])
  assert.deepEqual((await settings("b")).executionOrder, ["local"])

  const config = {
    ...defaultScorer,
    type: "javascript" as const,
    name: "Container scorer",
    slug: "container-scorer",
    code: "function evaluate({trace}) { return {score: trace.input === trace.output ? 1 : 0} }",
  }
  const sample = () =>
    testScorer(
      new Request("http://localhost:3000/api/scorers/test", {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          origin: "http://localhost:3000",
          "content-type": "application/json",
          "x-project-id": "a",
        },
        body: JSON.stringify({
          config,
          code: config.code,
          sample: { input: "hello", output: "hello" },
        }),
      })
    )
  const empty = await (await sample()).json()
  assert.equal(empty.data.error.kind, "sandbox", JSON.stringify(empty))
  assert.equal(
    (await PUT(request("PUT", { provider: "local" }), context())).status,
    200
  )
  if (process.env.DATOOL_TEST_SANDBOX_CONTAINERS === "1") {
    const result = await (await sample()).json()
    assert.equal(result.data.score, 1, JSON.stringify(result))
    assert.equal(result.data.metadata.sandboxProvider, "local")
    const service = await createTestTracerService(
      process.env.DATABASE_URL!,
      "a"
    )
    const scorer = await Effect.runPromise(service.scorers.save(config))
    await db.query(
      `INSERT INTO traces (id, project_id, name, operation, status, started_at, input_json, output_json) VALUES ('sandbox-trace', 'a', 'Sandbox trace', 'test', 'completed', '2026-09-17', '"hello"', '"hello"')`
    )
    const preview = await Effect.runPromise(
      service.agent.testScorer({ traceId: "sandbox-trace", scorer: config })
    )
    assert.equal(preview.result.score, 1)
    assert.equal(preview.result.metadata?.sandboxProvider, "local")
    const run = await Effect.runPromise(
      service.createEvalRun({
        evaluatorIds: [scorer.id],
        traceIds: ["sandbox-trace"],
      })
    )
    assert.equal(run.status, "completed")
    console.log("PASS container sample, trace preview and saved evaluation")
  }
  console.log(
    "PASS sandbox settings permissions, encryption, isolation, defaults, rotation, removal"
  )
} finally {
  await db.end()
}
process.exit(0)
