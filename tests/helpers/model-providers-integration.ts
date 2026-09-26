import { strict as assert } from "node:assert"
import { makeSignature } from "better-auth/crypto"
import { Effect } from "effect"
import { getAuth } from "../../lib/auth"
import { db } from "../../lib/db"
import {
  GET,
  PUT,
  DELETE,
} from "../../app/api/projects/[projectId]/providers/route"
import { GET as modelsGET } from "../../app/api/projects/[projectId]/providers/models/route"
import { POST as testScorer } from "../../app/api/scorers/test/route"
import { defaultScorer } from "../../src/lib/tracer/scorers"
import { defaultLibraryScorer } from "../../src/lib/tracer/scorer-libraries"
import { GET as libraryCatalog, POST as selectLibrary } from "../../app/api/scorers/libraries/route"
import {
  GATEWAY_PROVIDER,
  OPENAI_PROVIDER,
  TYPESAFE_PROVIDER,
} from "../../src/lib/model-providers"
import {
  getGatewayKey,
  getProjectProviderKey,
} from "../../src/server/model-providers/store"
import { resolveJudgeOptions } from "../../src/server/model-providers/judge"
import { previewPrompt } from "../../src/server/tracer/prompt-preview"
import { defaultPrompt } from "../../src/lib/tracer/prompts"
import { decryptProviderKey } from "../../src/server/model-providers/secrets"
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
    const signature = await makeSignature(session.token, auth.secret)
    return {
      user,
      cookie: `${auth.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`,
    }
  }
  const owner = await userSession("provider-owner")
  const member = await userSession("provider-member")
  const outsider = await userSession("provider-outsider")
  const organization = await getAuth().api.createOrganization({
    headers: new Headers({ cookie: owner.cookie }),
    body: { name: "Provider test", slug: "provider-test" },
  })
  assert(organization)
  await db.query(
    `INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ('member', $1, $2, 'member', now())`,
    [organization.id, member.user.id]
  )
  await db.query(
    `INSERT INTO project (id, organization_id, name, slug) VALUES ('a', $1, 'A', 'a'), ('b', $1, 'B', 'b')`,
    [organization.id]
  )
  const context = (projectId = "a") => ({
    params: Promise.resolve({ projectId }),
  })
  function request(
    method: string,
    cookie = owner.cookie,
    body?: unknown,
    origin = "http://localhost:3000"
  ) {
    return new Request("http://localhost:3000/api/projects/a/providers", {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        origin,
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }
  const keyA = "test-gateway-project-a"
  const keyB = "test-gateway-project-b"
  const input = { provider: GATEWAY_PROVIDER, apiKey: keyA }
  assert.equal((await GET(request("GET", ""), context())).status, 401)
  assert.equal(
    (await modelsGET(request("GET", outsider.cookie), context())).status,
    403
  )
  assert.equal(
    (await PUT(request("PUT", outsider.cookie, input), context())).status,
    403
  )
  assert.equal(
    (await PUT(request("PUT", member.cookie, input), context())).status,
    403
  )
  assert.equal(
    (await DELETE(request("DELETE", member.cookie, input), context())).status,
    403
  )
  assert.equal(
    (
      await PUT(
        request("PUT", owner.cookie, input, "https://evil.example"),
        context()
      )
    ).status,
    403
  )
  assert.equal(
    (
      await PUT(
        request("PUT", owner.cookie, { ...input, apiKey: " " }),
        context()
      )
    ).status,
    400
  )
  assert.equal(
    (
      await PUT(
        request("PUT", owner.cookie, { ...input, apiKey: "x".repeat(9000) }),
        context()
      )
    ).status,
    413
  )
  const saved = await PUT(request("PUT", owner.cookie, input), context())
  assert.equal(saved.status, 200)
  assert(!(await saved.text()).includes(keyA))
  const status = await GET(request("GET", member.cookie), context())
  assert.equal((await status.json()).providers[0].configured, true)
  const row = (
    await db.query(
      "SELECT encrypted_api_key FROM project_model_provider WHERE project_id='a'"
    )
  ).rows[0]
  assert(!row.encrypted_api_key.includes(keyA))
  assert.equal(await getGatewayKey("a"), keyA)
  await assert.rejects(() => getGatewayKey("b"), /Configure Vercel/)
  assert.equal(
    (
      await PUT(
        request("PUT", owner.cookie, { ...input, apiKey: keyB }),
        context("b")
      )
    ).status,
    200
  )
  assert.equal(await getGatewayKey("b"), keyB)

  const typeSafeKeyA = "test-typesafe-project-a"
  const typeSafeKeyB = "test-typesafe-project-b"
  const typeSafeInput = { provider: TYPESAFE_PROVIDER, apiKey: typeSafeKeyA }
  const typeSafeConfig = {
    ...defaultScorer,
    provider: TYPESAFE_PROVIDER,
    model: "jev-latest",
    modelType: "evaluation" as const,
  }
  await assert.rejects(
    () => resolveJudgeOptions(typeSafeConfig, "a"),
    /Configure TypeSafe AI/
  )
  for (const cookie of [member.cookie, outsider.cookie]) {
    assert.equal(
      (await PUT(request("PUT", cookie, typeSafeInput), context())).status,
      403
    )
    assert.equal(
      (await DELETE(request("DELETE", cookie, typeSafeInput), context()))
        .status,
      403
    )
  }
  for (const [projectId, apiKey] of [
    ["a", typeSafeKeyA],
    ["b", typeSafeKeyB],
  ]) {
    const response = await PUT(
      request("PUT", owner.cookie, { ...typeSafeInput, apiKey }),
      context(projectId)
    )
    assert.equal(response.status, 200)
    assert(!(await response.text()).includes(apiKey))
    assert.equal(
      await getProjectProviderKey(projectId, TYPESAFE_PROVIDER),
      apiKey
    )
  }
  const typeSafeRow = (
    await db.query(
      "SELECT encrypted_api_key FROM project_model_provider WHERE project_id='a' AND provider=$1",
      [TYPESAFE_PROVIDER]
    )
  ).rows[0]
  assert(!typeSafeRow.encrypted_api_key.includes(typeSafeKeyA))
  assert.throws(
    () =>
      decryptProviderKey(typeSafeRow.encrypted_api_key, "a", GATEWAY_PROVIDER),
    /Unable to unlock/
  )
  assert.throws(
    () =>
      decryptProviderKey(typeSafeRow.encrypted_api_key, "b", TYPESAFE_PROVIDER),
    /Unable to unlock/
  )
  assert.equal(await getGatewayKey("a"), keyA)
  assert.equal(await getGatewayKey("b"), keyB)

  const openaiKeys = ["test-openai-project-a", "test-openai-project-b"] as const
  const openaiConfig = { ...defaultScorer, provider: OPENAI_PROVIDER, model: "gpt-4.1-mini" }
  await assert.rejects(() => resolveJudgeOptions(openaiConfig, "a"), /Configure OpenAI/)
  for (const cookie of [member.cookie, outsider.cookie]) {
    assert.equal((await PUT(request("PUT", cookie, { provider: OPENAI_PROVIDER, apiKey: openaiKeys[0] }), context())).status, 403)
    assert.equal((await DELETE(request("DELETE", cookie, { provider: OPENAI_PROVIDER }), context())).status, 403)
  }
  for (const [index, projectId] of ["a", "b"].entries()) {
    const apiKey = openaiKeys[index]
    const saved = await PUT(request("PUT", owner.cookie, { provider: OPENAI_PROVIDER, apiKey }), context(projectId))
    assert.equal(saved.status, 200)
    assert(!(await saved.text()).includes(apiKey))
    assert.deepEqual(await resolveJudgeOptions(openaiConfig, projectId), {
      provider: OPENAI_PROVIDER, apiKey, baseUrl: "https://api.openai.com/v1",
    })
    const row = (await db.query("SELECT encrypted_api_key FROM project_model_provider WHERE project_id=$1 AND provider=$2", [projectId, OPENAI_PROVIDER])).rows[0]
    assert(!row.encrypted_api_key.includes(apiKey))
    assert.throws(() => decryptProviderKey(row.encrypted_api_key, projectId, GATEWAY_PROVIDER), /Unable to unlock/)
    assert.throws(() => decryptProviderKey(row.encrypted_api_key, projectId === "a" ? "b" : "a", OPENAI_PROVIDER), /Unable to unlock/)
    const preview = await previewPrompt({
      config: { ...defaultPrompt, provider: OPENAI_PROVIDER, model: "gpt-4.1-mini" },
      messages: [{ role: "user", content: "Hi" }],
    }, projectId, { fetch: (async (url, init) => {
      assert.equal(String(url), "https://api.openai.com/v1/responses")
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${apiKey}`)
      return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Hello" }] }] })
    }) as typeof fetch })
    assert.equal(preview.content, "Hello")
  }

  const originalFetch = globalThis.fetch
  const calls: { authorization: string | null; model: string }[] = []
  globalThis.fetch = (async (url, init) => {
    if (String(url) === "https://models.dev/api.json")
      return new Response(null, { status: 503 })
    if (String(url) === "https://api.openai.com/v1/responses") {
      const body = JSON.parse(String(init?.body))
      assert.equal(body.text.format.strict, true)
      assert.equal(body.store, false)
      calls.push({ authorization: new Headers(init?.headers).get("authorization"), model: body.model })
      return Response.json({
        status: "completed", model: body.model,
        usage: { input_tokens: 20, output_tokens: 10 },
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ choice: "Pass", reason: "Matches" }) }] }],
      })
    }
    if (String(url) === "https://api.typesafe.ai/v1/systemone") {
      const body = JSON.parse(String(init?.body))
      assert.equal(body.questions.verdict.type, "choice")
      calls.push({
        authorization: new Headers(init?.headers).get("authorization"),
        model: body.model,
      })
      return Response.json({
        model: body.model,
        answers: {
          verdict: {
            type: "choice",
            choice: "choice_1",
            probabilities: { choice_0: 0, choice_1: 1 },
          },
        },
        usage: { input_tokens: 20, output_tokens: 0 },
      })
    }
    if (String(url) === "https://ai-gateway.vercel.sh/v4/ai/evaluation-model") {
      const headers = new Headers(init?.headers)
      const body = JSON.parse(String(init?.body))
      assert.equal(body.questions.verdict.type, "choice")
      calls.push({
        authorization: headers.get("authorization"),
        model: headers.get("ai-model-id")!,
      })
      return Response.json({
        answers: { verdict: { type: "choice", choice: "choice_1" } },
        usage: { inputTokens: 20, outputTokens: 0 },
      })
    }
    assert.equal(
      String(url),
      "https://ai-gateway.vercel.sh/v1/chat/completions"
    )
    const body = JSON.parse(String(init?.body))
    if (!body.tools) assert.equal(body.response_format.json_schema.strict, true)
    calls.push({
      authorization: new Headers(init?.headers).get("authorization"),
      model: body.model,
    })
    if (body.tools) return Response.json({ model: body.model, usage: { prompt_tokens: 20, completion_tokens: 10 }, choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ type: "function", function: { name: "select_choice", arguments: JSON.stringify({ choice: "C", reasons: "The answers agree." }) } }] } }] })
    return Response.json({
      model: body.model,
      usage: { prompt_tokens: 20, completion_tokens: 10 },
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              choice: "Pass",
              reason: "Test evidence matches.",
            }),
          },
        },
      ],
    })
  }) as typeof fetch
  try {
    for (const { provider, model, modelType, keys } of [
      { provider: OPENAI_PROVIDER, model: "gpt-4.1-mini", modelType: "language", keys: openaiKeys },
      {
        provider: GATEWAY_PROVIDER,
        model: "openai/gpt-4.1-mini",
        modelType: "language",
        keys: [keyA, keyB],
      },
      {
        provider: GATEWAY_PROVIDER,
        model: "typesafe-ai/jev",
        modelType: "evaluation",
        keys: [keyA, keyB],
      },
      {
        provider: TYPESAFE_PROVIDER,
        model: "jev-latest",
        modelType: "evaluation",
        keys: [typeSafeKeyA, typeSafeKeyB],
      },
    ] as const) {
      calls.length = 0
      const config = {
        ...defaultScorer,
        provider,
        model,
        modelType,
        name: `${provider} scorer ${modelType}`,
        slug: `${provider}-scorer-${modelType}`,
      }
      for (const projectId of ["a", "b"]) {
        const response = await testScorer(
          new Request("http://localhost:3000/api/scorers/test", {
            method: "POST",
            headers: {
              cookie: owner.cookie,
              origin: "http://localhost:3000",
              "content-type": "application/json",
              "x-project-id": projectId,
            },
            body: JSON.stringify({
              config,
              sample: { input: "test", output: "ok", expected: "ok" },
            }),
          })
        )
        assert.equal(response.status, 200)
        const body = await response.json()
        assert.equal(body.data.score, 1, JSON.stringify(body))
        assert.equal(body.data.metadata.judgeProvider, provider)
        assert(!JSON.stringify(body).includes(keyA))
        assert(!JSON.stringify(body).includes(keyB))
        assert(!JSON.stringify(body).includes(typeSafeKeyA))
        assert(!JSON.stringify(body).includes(typeSafeKeyB))
        for (const key of openaiKeys) assert(!JSON.stringify(body).includes(key))
      }
      assert.deepEqual(
        calls.map((call) => call.authorization),
        keys.map((key) => `Bearer ${key}`)
      )
      assert(calls.every((call) => call.model === config.model))
      const service = await createTestTracerService(
        process.env.DATABASE_URL!,
        "a"
      )
      const scorer = await Effect.runPromise(service.scorers.save(config))
      assert.equal(
        (await Effect.runPromise(service.scorers.get(scorer.id))).provider,
        provider
      )
      assert.equal(
        (await Effect.runPromise(service.scorers.get(scorer.id))).modelType,
        modelType
      )
      const traceId = `provider-trace-${provider}-${modelType}`
      await db.query(
        `INSERT INTO traces (id, project_id, name, operation, status, started_at, input_json, output_json) VALUES ($1, 'a', 'Provider trace', 'test', 'completed', '2026-09-16', '"test"', '"ok"')`,
        [traceId]
      )
      const preview = await Effect.runPromise(
        service.agent.testScorer({
          traceId,
          scorer: {
            ...config,
            messages: [{ role: "user", content: "Evaluate {{output}}" }],
          },
        })
      )
      assert.equal(preview.result.score, 1)
      const run = await Effect.runPromise(
        service.createEvalRun({
          evaluatorIds: [scorer.id],
          traceIds: [traceId],
        })
      )
      assert.equal(run.status, "completed")
      assert(
        calls.length >= 4,
        "sample, trace and saved evaluation must execute the selected provider"
      )
      assert.equal(calls.at(-1)?.authorization, `Bearer ${keys[0]}`)
      assert(calls.every((call) => call.model === config.model))
    }
    const discoveryRequest = (cookie: string) => new Request("http://localhost:3000/api/scorers/libraries", { headers: { cookie, "x-project-id": "a" } })
    const selectionRequest = (cookie: string, projectId = "a") => new Request("http://localhost:3000/api/scorers/libraries", {
      method: "POST",
      headers: { cookie, "x-project-id": projectId, origin: "http://localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({ evaluator: "ValidJSON" }),
    })
    assert.equal((await selectLibrary(selectionRequest(outsider.cookie))).status, 403)
    assert.equal((await selectLibrary(selectionRequest(""))).status, 401)
    const selectedA = await (await selectLibrary(selectionRequest(owner.cookie))).json()
    const selectedB = await (await selectLibrary(selectionRequest(owner.cookie, "b"))).json()
    assert.equal(selectedA.data.activeVersion.config.library.evaluator, "ValidJSON")
    assert.notEqual(selectedA.data.id, selectedB.data.id)
    assert.equal((await (await selectLibrary(selectionRequest(owner.cookie))).json()).data.id, selectedA.data.id)
    assert.equal((await libraryCatalog(discoveryRequest(outsider.cookie))).status, 403)
    assert.equal((await libraryCatalog(discoveryRequest(""))).status, 401)
    assert.equal((await (await libraryCatalog(discoveryRequest(owner.cookie))).json()).data.libraries[0].evaluators.length, 6)
    calls.length = 0
    for (const projectId of ["a", "b"]) {
      const config = { ...defaultScorer, type: "library", name: "Library Factuality", slug: "library-factuality", provider: GATEWAY_PROVIDER, model: "openai/gpt-4.1-mini", library: defaultLibraryScorer("Factuality") }
      const response = await testScorer(new Request("http://localhost:3000/api/scorers/test", {
        method: "POST", headers: { cookie: owner.cookie, origin: "http://localhost:3000", "content-type": "application/json", "x-project-id": projectId },
        body: JSON.stringify({ config, sample: { input: "Question", output: "Answer", expected: "Answer" } }),
      }))
      assert.equal(response.status, 200)
      const result = await response.json()
      assert.equal(result.data.score, 1, JSON.stringify(result))
      assert(!JSON.stringify(result).includes(keyA))
      assert(!JSON.stringify(result).includes(keyB))
    }
    assert.deepEqual(calls.map((call) => call.authorization), [keyA, keyB].map((key) => `Bearer ${key}`))
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(
    (
      await PUT(
        request("PUT", owner.cookie, {
          ...typeSafeInput,
          apiKey: "typesafe-replacement",
        }),
        context()
      )
    ).status,
    200
  )
  assert.equal(
    await getProjectProviderKey("a", TYPESAFE_PROVIDER),
    "typesafe-replacement"
  )
  assert.equal(await getGatewayKey("a"), keyA)
  assert.equal(
    (
      await DELETE(
        request("DELETE", owner.cookie, { provider: TYPESAFE_PROVIDER }),
        context()
      )
    ).status,
    200
  )
  await assert.rejects(
    () => resolveJudgeOptions(typeSafeConfig, "a"),
    /Configure TypeSafe AI/
  )
  assert.equal(
    await getProjectProviderKey("b", TYPESAFE_PROVIDER),
    typeSafeKeyB
  )
  assert.equal(await getGatewayKey("a"), keyA)

  assert.equal(
    (
      await PUT(
        request("PUT", owner.cookie, { ...input, apiKey: "replacement-key" }),
        context()
      )
    ).status,
    200
  )
  assert.equal(await getGatewayKey("a"), "replacement-key")
  assert.equal(
    (
      await DELETE(
        request("DELETE", owner.cookie, { provider: GATEWAY_PROVIDER }),
        context()
      )
    ).status,
    200
  )
  assert.equal(
    (await (await GET(request("GET"), context())).json()).providers[0]
      .configured,
    false
  )
  await assert.rejects(() => getGatewayKey("a"), /Configure Vercel/)
  assert.equal(await getGatewayKey("b"), keyB)
  assert.equal((await PUT(request("PUT", owner.cookie, { provider: OPENAI_PROVIDER, apiKey: "replacement-openai-key" }), context())).status, 200)
  assert.equal(await getProjectProviderKey("a", OPENAI_PROVIDER), "replacement-openai-key")
  assert.equal((await DELETE(request("DELETE", owner.cookie, { provider: OPENAI_PROVIDER }), context())).status, 200)
  await assert.rejects(() => resolveJudgeOptions(openaiConfig, "a"), /Configure OpenAI/)
  assert.equal(await getProjectProviderKey("b", OPENAI_PROVIDER), openaiKeys[1])
  assert.equal(await getProjectProviderKey("b", TYPESAFE_PROVIDER), typeSafeKeyB)
  assert.equal(await getGatewayKey("b"), keyB)
  console.log(
    "PASS provider permissions, encryption, isolation, rotation, deletion, sample/trace/evaluation execution"
  )
} finally {
  await db.end()
}
process.exit(0)
