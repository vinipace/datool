import assert from "node:assert/strict"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { promisify } from "node:util"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
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
import type { EvalRunDetail } from "../src/lib/tracer/contracts"

// No mocked catalog, relay, auth or evaluation services: a loopback HTTP adapter
// dispatches to the actual Next route handlers. A disposable schema owns all data.
const execute = promisify(execFile)
const directory = await mkdtemp(join(tmpdir(), "datool-brand-e2e-"))
const target = await createIsolatedPostgres()
const root = process.cwd()
const binary = resolve(
  process.env.DATOOL_TEST_CLI_BINARY ?? "packages/cli/dist/datool.js"
)
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
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  Object.assign(process.env, {
    DATABASE_URL: target.databaseUrl,
    BETTER_AUTH_URL: "http://127.0.0.1:3000",
    BETTER_AUTH_SECRET: "disposable-brand-experiments-secret-123456789",
    DATOOL_DATA_DIR: join(directory, "data"),
    NODE_ENV: "test",
  })
  pools = await import("../lib/db")
  const { getAuth } = await import("../lib/auth")
  const credential = await getAuth().api.createApiKey({
    body: {
      organizationId: target.organizationId,
      userId: target.ownerId,
      name: "Brand E2E",
      permissions: permissionStatements(workspaceScopes),
      rateLimitMax: 10000,
    },
  })
  const [config, sessions, exchange, agent, evals] = await Promise.all([
    import("../app/api/apps/config/route"),
    import("../app/api/apps/bridges/route"),
    import("../app/api/apps/bridges/exchange/route"),
    import("../app/api/agent/[operation]/route"),
    import("../app/api/evals/route"),
  ])
  listener = await serveWebhook(async (request) => {
    const path = new URL(request.url).pathname
    if (path === "/api/apps/config") return config.POST(request)
    if (path === "/api/apps/bridges") return sessions.POST(request)
    if (path === "/api/apps/bridges/exchange") return exchange.POST(request)
    if (path === "/api/evals") return evals.POST(request)
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
  async function api(body: unknown, expectedStatus = 200) {
    const response = await fetch(origin + "/api/evals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credential.key}`,
        "x-project-id": target.projectId,
      },
      body: JSON.stringify(body),
    })
    const result = await response.json()
    assert.equal(response.status, expectedStatus, JSON.stringify(result))
    return result.data as EvalRunDetail
  }
  const tools = await cli(["agent", "tools", "start_eval_run"])
  assert(JSON.stringify(tools).includes('"inputOverrides"'))
  passed(
    "CLI/MCP shared discovery exposes inputOverrides over authenticated HTTP"
  )
  const dataset = await cli(["datasets", "create"], {
    name: "brand-experiment-e2e",
  })
  await cli(["datasets", "bulk", dataset.id], {
    create: [
      {
        id: "case-a",
        input: { value: 1, model: "original" },
        expectedOutput: { value: 1 },
        metadata: { referenceOnly: true },
      },
      {
        id: "case-b",
        input: { value: 2, model: "original" },
        expectedOutput: { value: 2 },
        metadata: { referenceOnly: true },
      },
    ],
  })
  const snapshot = await cli(["datasets", "snapshot", dataset.id])
  const scorer = await cli(["scorers", "create"], {
    scorer: {
      ...defaultScorer,
      name: "Echo references",
      slug: "echo-references",
      type: "javascript",
      code: 'function evaluate({trace,datasetItem}) { return {score: trace.output.value === datasetItem.expectedOutput.value && datasetItem.input.model === "original" ? 1 : 0}; }',
    },
  })
  await writeFile(join(directory, "package.json"), '{"type":"module"}')
  await writeFile(join(directory, "version.ts"), 'export const version = "one"')
  const manifest = (strict = false) => `import {version} from './version.ts';
    import {appendFile,access} from 'node:fs/promises';
    import {setTimeout as delay} from 'node:timers/promises';
    export default {apps:[{id:'extract',name:'Extractor',type:'workflow',inputSchema:${JSON.stringify({ $id: "urn:datool:brand-e2e-input", type: "object", required: strict ? ["value", "model", "promptVersion"] : ["value", "model"], additionalProperties: false, properties: { value: { type: "number" }, model: { type: "string" }, promptVersion: { type: "number" }, hold: { type: "boolean" } } })},outputSchema:{type:'object'},handler:async input=>{
      await appendFile('calls.log',JSON.stringify(input)+'\\n');
      if(input.hold) {await appendFile('started.flag','started'); while(!await access('release.flag').then(()=>true,()=>false)) await delay(25);}
      return {...input,version};
    }}]}`
  await writeFile(join(directory, "datool.config.ts"), manifest())
  bridge = spawn("node", [binary, "connect", "--watch"], {
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
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      if (await predicate()) return
      assert.equal(bridge!.exitCode, null, log)
      await pause(50)
    }
    throw new Error(`Timed out: ${description}\n${log}`)
  }
  await waitFor(async () => log.includes("Listening for"), "initial listener")
  const input = {
    mode: "connected",
    appId: "extract",
    datasetId: dataset.id,
    datasetVersionId: snapshot.id,
    evaluatorIds: [scorer.id],
    inputOverrides: { model: "candidate-a", promptVersion: 1 },
  }
  const baseline = await cli(
    ["evals", "run", "--wait", "--poll-interval", "0.1"],
    { ...input, requestKey: "baseline" }
  )
  assert.equal(baseline.status, "completed")
  assert.equal(baseline.resultCount, 2)
  assert.equal(
    (await cli(["evals", "run"], { ...input, requestKey: "baseline" })).id,
    baseline.id
  )
  await api({ ...input, inputOverrides: { model: 123 } }, 400)
  assert.equal(
    (await readFile(join(directory, "calls.log"), "utf8")).trim().split("\n")
      .length,
    2
  )
  const original = await cli(["datasets", "get", dataset.id])
  assert(
    original.items.every(
      (item: { input: { model: string } }) => item.input.model === "original"
    )
  )
  passed(
    "built CLI → authenticated API → PostgreSQL relay → watched handler → frozen/scored eval; retry invokes zero extra calls"
  )

  const held = await api({
    ...input,
    datasetItemIds: ["case-a"],
    inputOverrides: { model: "candidate-a", promptVersion: 1, hold: true },
  })
  await waitFor(
    async () =>
      !!(await readFile(join(directory, "started.flag")).catch(() => null)),
    "in-flight handler"
  )
  const previousListeners = log.split("Listening for").length
  await writeFile(join(directory, "version.ts"), 'export const version = "two"')
  await writeFile(join(directory, "datool.config.ts"), manifest(true))
  await waitFor(async () => log.includes("finishing active calls"), "drain")
  assert.equal(log.split("Listening for").length, previousListeners)
  await writeFile(join(directory, "release.flag"), "release")
  await cli(["evals", "wait", held.id, "--poll-interval", "0.1"])
  await waitFor(
    async () => log.split("Listening for").length > previousListeners,
    "updated listener"
  )
  const heldResult = await cli(["evals", "get", held.id])
  assert.equal(heldResult.rows[0].trace.output.version, "one")
  const app = await cli(["apps", "get", "extract"])
  assert(app.inputSchema.required.includes("promptVersion"))
  passed(
    "actual relay delivers an in-flight old-code result before watcher resyncs the new schema"
  )

  await cli(["datasets", "bulk", dataset.id], { delete: ["case-a", "case-b"] })
  const candidate = await cli(
    ["evals", "run", "--wait", "--poll-interval", "0.1"],
    {
      ...input,
      inputOverrides: { model: "candidate-b", promptVersion: 2 },
      requestKey: "candidate",
    }
  )
  const candidateDetail = await cli(["evals", "get", candidate.id])
  assert(
    candidateDetail.rows.every(
      (row: {
        datasetItemId: unknown
        datasetCaseId: string
        trace: { output: { version: string } }
      }) =>
        row.datasetItemId === null &&
        row.datasetCaseId &&
        row.trace.output.version === "two"
    )
  )
  const compare = await cli([
    "evals",
    "compare",
    "--left-id",
    baseline.id,
    "--right-id",
    candidate.id,
  ])
  assert.equal(compare.total, 2)
  assert(
    compare.pairs.every(
      (pair: { matchedBy: string }) => pair.matchedBy === "dataset item"
    )
  )
  const rescored = await cli(
    ["evals", "rescore", baseline.id, "--wait", "--poll-interval", "0.1"],
    { evaluatorIds: [scorer.id], requestKey: "rescore" }
  )
  const rescoredDetail = await cli(["evals", "get", rescored.id])
  assert(
    rescoredDetail.rows.every(
      (row: { trace: { output: { version: string } } }) =>
        row.trace.output.version === "one"
    )
  )
  assert.deepEqual(rescoredDetail.metadata.inputOverrides, input.inputOverrides)
  const calls = (await readFile(join(directory, "calls.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  assert.equal(calls.length, 5)
  assert(
    calls.every(
      (call) =>
        !("expectedOutput" in call) &&
        !("metadata" in call) &&
        !("referenceOnly" in call)
    )
  )
  passed(
    "deleted snapshot cases pair across overrides; re-scoring retains old effective inputs and invokes zero app calls"
  )
  const report = {
    checks,
    calls,
    runs: {
      baseline: baseline.id,
      held: held.id,
      candidate: candidate.id,
      rescored: rescored.id,
    },
    comparison: {
      total: compare.total,
      matchedBy: compare.pairs.map(
        (pair: { matchedBy: string }) => pair.matchedBy
      ),
    },
    appRevision: app.revision,
    status:
      "local disposable route-handler E2E; no production or hosted deployment",
  }
  await mkdir(join(root, "artifacts/brand-experiments-e2e"), {
    recursive: true,
  })
  await writeFile(
    join(root, "artifacts/brand-experiments-e2e/route-e2e.json"),
    JSON.stringify(report, null, 2) + "\n"
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
  if (pools) await Promise.all([pools.db.end(), pools.analyticsDb.end()])
  await target.close()
  await rm(directory, { recursive: true, force: true })
}
