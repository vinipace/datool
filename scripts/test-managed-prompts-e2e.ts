import assert from "node:assert/strict"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { promisify } from "node:util"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "../tests/helpers/postgres"
import { serveWebhook } from "../src/server/apps/webhook"
import {
  permissionStatements,
  workspaceScopes,
} from "../src/lib/auth/permissions"
import { defaultScorer } from "../src/lib/tracer/scorers"
import { defaultPrompt } from "../src/lib/tracer/prompts"
import type { EvalRunDetail } from "../src/lib/tracer/contracts"

// Real route handlers, authentication, database, relay, built CLI and built SDK.
// Deterministic local application output; no model-provider API or production data.
const execute = promisify(execFile)
const directory = await mkdtemp(join(tmpdir(), "datool-prompts-e2e-"))
const target = await createIsolatedPostgres()
const root = process.cwd()
const binary = resolve("packages/cli/dist/datool.js")
const sdk = pathToFileURL(resolve("packages/sdk/dist/index.js")).href
let pools: typeof import("../lib/db") | undefined
let bridge: ChildProcess | undefined
let listener: Awaited<ReturnType<typeof serveWebhook>> | undefined
let log = ""
const checks: string[] = []
const passed = (check: string) => {
  checks.push(check)
  console.info(`PASS ${check}`)
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
try {
  const redisUrl = process.env.DATOOL_TEST_REDIS_URL
  if (
    redisUrl &&
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(redisUrl).hostname)
  )
    throw new Error(
      "DATOOL_TEST_REDIS_URL must use a disposable loopback Redis"
    )
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  Object.assign(process.env, {
    DATABASE_URL: target.databaseUrl,
    REDIS_URL: process.env.DATOOL_TEST_REDIS_URL ?? "",
    BETTER_AUTH_URL: "http://127.0.0.1:3000",
    BETTER_AUTH_SECRET: "disposable-managed-prompts-secret-123456789",
    DATOOL_DATA_DIR: join(directory, "data"),
    NODE_ENV: "test",
  })
  pools = await import("../lib/db")
  const { getAuth } = await import("../lib/auth")
  const credential = await getAuth().api.createApiKey({
    body: {
      organizationId: target.organizationId,
      userId: target.ownerId,
      name: "Prompts E2E",
      permissions: permissionStatements(workspaceScopes),
      rateLimitMax: 10000,
    },
  })
  const [
    config,
    sessions,
    exchange,
    agent,
    evals,
    prompts,
    prompt,
    publish,
    bySlug,
    frozen,
    spans,
  ] = await Promise.all([
    import("../app/api/apps/config/route"),
    import("../app/api/apps/bridges/route"),
    import("../app/api/apps/bridges/exchange/route"),
    import("../app/api/agent/[operation]/route"),
    import("../app/api/evals/route"),
    import("../app/api/prompts/route"),
    import("../app/api/prompts/[id]/route"),
    import("../app/api/prompts/[id]/publish/route"),
    import("../app/api/prompts/by-slug/[slug]/route"),
    import("../app/api/evals/[id]/prompts/route"),
    import("../app/api/traces/[id]/spans/route"),
  ])
  let promptReads = 0
  listener = await serveWebhook(async (request) => {
    const path = new URL(request.url).pathname
    if (path === "/api/apps/config") return config.POST(request)
    if (path === "/api/apps/bridges") return sessions.POST(request)
    if (path === "/api/apps/bridges/exchange") return exchange.POST(request)
    if (path === "/api/evals") return evals.POST(request)
    if (/^\/api\/traces\/[^/]+\/spans$/.test(path))
      return spans.POST(request, {
        params: Promise.resolve({ id: path.split("/")[3] }),
      })
    if (path === "/api/prompts") return prompts.POST(request)
    if (path.startsWith("/api/prompts/by-slug/")) {
      promptReads++
      return bySlug.GET(request, {
        params: Promise.resolve({ slug: path.split("/").at(-1)! }),
      })
    }
    if (/^\/api\/prompts\/[^/]+\/publish$/.test(path))
      return publish.POST(request, {
        params: Promise.resolve({ id: path.split("/")[3] }),
      })
    if (path.startsWith("/api/prompts/"))
      return prompt.PUT(request, {
        params: Promise.resolve({ id: path.split("/")[3] }),
      })
    if (/^\/api\/evals\/[^/]+\/prompts$/.test(path))
      return frozen.GET(request, {
        params: Promise.resolve({ id: path.split("/")[3] }),
      })
    if (path.startsWith("/api/agent/"))
      return agent.POST(request, {
        params: Promise.resolve({
          operation: path.slice("/api/agent/".length),
        }),
      })
    return Response.json(
      { error: { message: "Unknown test route" } },
      { status: 404 }
    )
  })
  const origin = `http://127.0.0.1:${listener.port}`
  const env = {
    ...process.env,
    DATOOL_BASE_URL: origin,
    DATOOL_PROJECT_ID: target.projectId,
    DATOOL_API_KEY: credential.key,
    DATOOL_CONFIG_DIR: join(directory, "credentials"),
  }
  async function cli(args: string[], input?: unknown) {
    const result = await execute(
      "node",
      [
        binary,
        ...args,
        ...(input === undefined ? [] : ["--input", JSON.stringify(input)]),
      ],
      { cwd: directory, env, timeout: 60000, maxBuffer: 8 * 1024 * 1024 }
    )
    return JSON.parse(result.stdout)
  }
  async function api(
    path: string,
    method = "GET",
    body?: unknown,
    status = 200
  ) {
    const response = await fetch(origin + path, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credential.key}`,
        "x-project-id": target.projectId,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const result = await response.json()
    assert.equal(response.status, status, JSON.stringify(result))
    return result.data
  }
  const promptInput = {
    ...defaultPrompt,
    name: "Brand",
    slug: "brand",
    model: "openai/gpt-4.1-mini",
    messages: [{ role: "user", content: "v1 {{value}}" }],
  }
  const created = await api("/api/prompts", "POST", promptInput)
  await api(`/api/prompts/${created.id}/publish`, "POST", {
    expectedRevision: 1,
  })
  const { createDatool } = await import(sdk)
  const standalone = createDatool({
    baseUrl: origin,
    apiKey: credential.key,
    projectId: target.projectId,
    promptCache: { latestTtlMs: 0 },
  })
  assert.equal(
    (await standalone.prompts.get("brand")).render({ value: "<A>" })[0].content,
    "v1 <A>"
  )
  // Editable drafts cannot enter the runtime cache.
  await api(`/api/prompts/${created.id}`, "PUT", {
    ...promptInput,
    messages: [{ role: "user", content: "draft {{value}}" }],
    expectedRevision: 2,
  })
  assert.equal(
    (await standalone.prompts.get("brand")).render({ value: "x" })[0].content,
    "v1 x"
  )
  await api(`/api/prompts/${created.id}`, "PUT", {
    ...promptInput,
    expectedRevision: 3,
  })
  // Revision is now 4; publishing unchanged draft keeps v1 and revision 4.
  passed(
    "built SDK standalone get/render uses published snapshots, literal substitution and authenticated project scope"
  )
  assert(
    JSON.stringify(await cli(["agent", "tools", "start_eval_run"])).includes(
      '"promptOverrides"'
    )
  )
  const dataset = await cli(["datasets", "create"], {
    name: "managed-prompt-cases",
  })
  await cli(["datasets", "bulk", dataset.id], {
    create: [1, 2].map((value) => ({
      id: `case-${value}`,
      input: { value },
      expectedOutput: { value },
      metadata: { reference: true },
    })),
  })
  const scorer = await cli(["scorers", "create"], {
    scorer: {
      ...defaultScorer,
      name: "Rendered",
      slug: "rendered",
      type: "javascript",
      code: "function evaluate({trace,datasetItem}) { return {score: trace.output.message.endsWith(String(datasetItem.expectedOutput.value)) ? 1 : 0}; }",
    },
  })
  await writeFile(join(directory, "package.json"), '{"type":"module"}')
  await writeFile(
    join(directory, "datool.config.ts"),
    `import {createDatool} from ${JSON.stringify(sdk)};
import {appendFile,access} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
const datool=createDatool();
export default {apps:[{id:'extract',name:'Prompt extractor',type:'workflow',inputSchema:{type:'object',required:['value'],properties:{value:{type:'number'},hold:{type:'boolean'},fail:{type:'boolean'}}},outputSchema:{type:'object'},handler:async input=>{
  await appendFile('calls.log',JSON.stringify(input)+'\\n');
  if(input.hold) {await appendFile('started.flag','started'); while(!await access('release.flag').then(()=>true,()=>false)) await delay(25);}
  const prompt=await datool.prompts.get('brand');
  if(input.fail) {datool.prompts.override('brand',{model:'failure-model'});throw new Error('intentional failure');}
  return {message:prompt.render({value:String(input.value)})[0].content,model:prompt.model,version:prompt.version};
}}]};`
  )
  bridge = spawn("node", [binary, "connect"], {
    cwd: directory,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  for (const stream of [bridge.stdout, bridge.stderr])
    stream!.on("data", (chunk) => {
      log = (log + chunk).slice(-24000)
    })
  async function waitFor(
    predicate: () => Promise<boolean>,
    description: string
  ) {
    const deadline = Date.now() + 25000
    while (Date.now() < deadline) {
      if (await predicate()) return
      assert.equal(bridge!.exitCode, null, log)
      await pause(30)
    }
    throw new Error(`Timed out: ${description}\n${log}`)
  }
  await waitFor(async () => log.includes("Listening for"), "listener")
  const input = {
    mode: "connected",
    appId: "extract",
    datasetId: dataset.id,
    evaluatorIds: [scorer.id],
    concurrency: 1,
  }
  const held = await cli(["evals", "run"], {
    ...input,
    inputOverrides: { hold: true },
    requestKey: "held",
  })
  await waitFor(
    async () =>
      !!(await readFile(join(directory, "started.flag")).catch(() => null)),
    "in-flight case before lazy prompt discovery"
  )
  const v2 = await api(`/api/prompts/${created.id}`, "PUT", {
    ...promptInput,
    messages: [{ role: "user", content: "v2 {{value}}" }],
    expectedRevision: 4,
  })
  await api(`/api/prompts/${created.id}/publish`, "POST", {
    expectedRevision: v2.revision,
  })
  await writeFile(join(directory, "release.flag"), "go")
  await waitFor(
    async () => (await cli(["evals", "get", held.id])).status !== "running",
    "held run"
  )
  const baseline: EvalRunDetail = await cli(["evals", "get", held.id])
  assert.equal(baseline.status, "completed", JSON.stringify(baseline))
  assert(
    baseline.rows!.every(
      (row) => (row.trace.output as { version: number }).version === 1
    )
  )
  assert.equal(
    (
      baseline.metadata.promptConfig as {
        prompts: { brand: { version: number } }
      }
    ).prompts.brand.version,
    1
  )
  passed(
    "all cases keep pre-publication v1, including first lazy lookup after v2 publication"
  )
  const [left, right] = await Promise.all([
    cli(["evals", "run", "--wait", "--poll-interval", "0.1"], {
      ...input,
      promptOverrides: { brand: { version: 1, model: "experiment-a" } },
      requestKey: "left",
    }),
    cli(["evals", "run", "--wait", "--poll-interval", "0.1"], {
      ...input,
      promptOverrides: { brand: { version: 2, model: "experiment-b" } },
      requestKey: "right",
    }),
  ])
  const leftDetail: EvalRunDetail = await cli(["evals", "get", left.id])
  const rightDetail: EvalRunDetail = await cli(["evals", "get", right.id])
  for (const [run, version, model] of [
    [leftDetail, 1, "experiment-a"],
    [rightDetail, 2, "experiment-b"],
  ] as const) {
    assert.equal(run.status, "completed")
    assert(
      run.rows!.every(
        (row) =>
          (row.trace.output as { version: number; model: string }).version ===
            version && (row.trace.output as { model: string }).model === model
      )
    )
    for (const row of run.rows!) {
      const target = await cli([
        "evals",
        "target",
        run.id,
        "--target-id",
        row.id,
      ])
      assert(
        target.scoringTrace.spans.some(
          (span: { attributes: Record<string, unknown> }) =>
            span.attributes["datool.prompt.version"] === version &&
            span.attributes["datool.prompt.model"] === model
        )
      )
    }
  }
  assert.equal(
    (
      await cli(["evals", "run"], {
        ...input,
        promptOverrides: { brand: { version: 1, model: "experiment-a" } },
        requestKey: "left",
      })
    ).id,
    left.id
  )
  await assert.rejects(
    cli(["evals", "run"], {
      ...input,
      promptOverrides: { brand: { version: 2 } },
      requestKey: "left",
    }),
    /HTTP 409/
  )
  await api(
    "/api/evals",
    "POST",
    { ...input, promptOverrides: { brand: { version: 999 } } },
    400
  )
  passed(
    "concurrent built SDK/CLI runs isolate prompt version/model, persist provenance, and deduplicate requestKey retries"
  )
  const failed = await cli(
    ["evals", "run", "--wait", "--poll-interval", "0.1"],
    {
      ...input,
      inputOverrides: { fail: true },
      promptOverrides: { brand: { model: "failed-run" } },
      requestKey: "failure",
    }
  ).catch((error) => JSON.parse(error.stdout))
  assert.equal(failed.status, "failed")
  const recovered = await cli(
    ["evals", "run", "--wait", "--poll-interval", "0.1"],
    { ...input, requestKey: "recovery" }
  )
  const recovery: EvalRunDetail = await cli(["evals", "get", recovered.id])
  assert(
    recovery.rows!.every(
      (row) =>
        (row.trace.output as { model: string }).model === promptInput.model
    )
  )
  passed(
    "failed handler overrides are cleaned before later invocations in the same bridge process"
  )
  const callsBefore = await readFile(join(directory, "calls.log"), "utf8")
  const readsBefore = promptReads
  const rescored = await cli(
    ["evals", "rescore", left.id, "--wait", "--poll-interval", "0.1"],
    { evaluatorIds: [scorer.id], requestKey: "rescore" }
  )
  const rescoredDetail: EvalRunDetail = await cli(["evals", "get", rescored.id])
  assert.deepEqual(
    rescoredDetail.metadata.promptConfig,
    leftDetail.metadata.promptConfig
  )
  assert.equal(
    await readFile(join(directory, "calls.log"), "utf8"),
    callsBefore
  )
  assert.equal(promptReads, readsBefore)
  const comparison = await cli(["evals", "compare"], {
    leftId: left.id,
    rightId: right.id,
  })
  assert.equal(comparison.total, 2)
  assert(
    comparison.pairs.every(
      (pair: { matchedBy: string }) => pair.matchedBy === "dataset item"
    )
  )
  const unchanged = await cli(["datasets", "get", dataset.id])
  assert(
    unchanged.items.every(
      (item: { input: unknown; expectedOutput: unknown; id: string }) =>
        JSON.stringify(item.input) === JSON.stringify(item.expectedOutput)
    )
  )
  passed(
    "re-scoring uses frozen prompt config and evidence with zero prompt reads/app calls; comparisons pair unchanged dataset cases"
  )
  await mkdir(join(root, "artifacts/managed-prompts-e2e"), { recursive: true })
  await writeFile(
    join(root, "artifacts/managed-prompts-e2e/route-e2e.json"),
    JSON.stringify(
      {
        checks,
        calls: callsBefore.trim().split("\n").length,
        promptReads,
        runs: {
          baseline: held.id,
          left: left.id,
          right: right.id,
          failed: failed.id,
          recovered: recovered.id,
          rescored: rescored.id,
        },
        comparison: {
          total: comparison.total,
          matchedBy: comparison.pairs.map(
            (pair: { matchedBy: string }) => pair.matchedBy
          ),
        },
        status:
          "disposable local route-handler E2E with built packages; deterministic application, no provider call or deployment",
      },
      null,
      2
    ) + "\n"
  )
} finally {
  if (bridge && bridge.exitCode === null && bridge.signalCode === null) {
    const exit = once(bridge, "exit")
    bridge.kill("SIGTERM")
    await Promise.race([exit, pause(10000)])
    if (bridge.exitCode === null && bridge.signalCode === null)
      bridge.kill("SIGKILL")
  }
  listener?.stop()
  if (pools) {
    const { routeCacheRedis } = await import("../src/server/cache/redis")
    routeCacheRedis()?.disconnect()
    await Promise.all([pools.db.end(), pools.analyticsDb.end()])
  }
  await target.close()
  await rm(directory, { recursive: true, force: true })
}
