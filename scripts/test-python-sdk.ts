import assert from "node:assert/strict"
import { execFile, type ExecFileOptions } from "node:child_process"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import type { QueryResult } from "pg"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "../tests/helpers/postgres"
import {
  permissionStatements,
  workspaceScopes,
} from "../src/lib/auth/permissions"
import { serveWebhook } from "../src/server/apps/webhook"

type PersistedSpan = {
  id: string
  name: string
  kind: string
  parent_id: string | null
  status: string
  input_json: string
  output_json: string
  attributes_json: Record<string, unknown>
}

// No configured app database or API credentials are used. All services are owned
// by this run, bound to loopback, and removed in finally, including on failure.
const execute = promisify(execFile)
const directory = await mkdtemp(join(tmpdir(), "datool-python-e2e-"))
const id = crypto.randomUUID().slice(0, 8)
const containers: string[] = []
const run = async (
  command: string,
  args: string[],
  options: ExecFileOptions = {}
) => {
  const result = await execute(command, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 180_000,
    ...options,
  })
  return String(result.stdout).trim()
}
const docker = (args: string[]) => run("docker", args)
let target: Awaited<ReturnType<typeof createIsolatedPostgres>> | undefined
let pools: typeof import("../lib/db") | undefined
let listener: Awaited<ReturnType<typeof serveWebhook>> | undefined
let worker:
  | ReturnType<
      (typeof import("../src/server/ingestion/worker"))["startIngestionWorker"]
    >
  | undefined
let queue: typeof import("../src/server/ingestion/queue") | undefined
let connection:
  | ReturnType<
      (typeof import("../src/server/ingestion/queue"))["redisConnection"]
    >
  | undefined
try {
  for (const [name, image, internal, args] of [
    [
      `datool-python-pg-${id}`,
      "postgres:18-alpine",
      "5432",
      ["-e", "POSTGRES_PASSWORD=python-fixture"],
    ],
    [`datool-python-redis-${id}`, "redis:7-alpine", "6379", []],
  ] as const) {
    await docker([
      "run",
      "-d",
      "--rm",
      "--name",
      name,
      "-p",
      `127.0.0.1::${internal}`,
      ...args,
      image,
    ])
    containers.push(name)
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await docker([
        "exec",
        containers[0],
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
      ])
      break
    } catch {
      if (attempt >= 60)
        throw new Error("Disposable PostgreSQL did not become ready")
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  const pgPort = (await docker(["port", containers[0], "5432/tcp"]))
    .split(":")
    .at(-1)
  const redisPort = (await docker(["port", containers[1], "6379/tcp"]))
    .split(":")
    .at(-1)
  delete process.env.DATABASE_URL
  process.env.DATOOL_TEST_DATABASE_URL = `postgresql://postgres:python-fixture@127.0.0.1:${pgPort}/postgres`
  target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  Object.assign(process.env, {
    DATABASE_URL: target.databaseUrl,
    REDIS_URL: `redis://127.0.0.1:${redisPort}`,
    BETTER_AUTH_URL: "http://127.0.0.1:3000",
    BETTER_AUTH_SECRET: `disposable-python-sdk-${id}-secret`,
    DATOOL_DATA_DIR: directory,
    NODE_ENV: "test",
  })
  pools = await import("../lib/db")
  const { getAuth } = await import("../lib/auth")
  const credential = await getAuth().api.createApiKey({
    body: {
      organizationId: target.organizationId,
      userId: target.ownerId,
      name: "Disposable Python SDK acceptance",
      permissions: permissionStatements(workspaceScopes),
      rateLimitMax: 10_000,
      rateLimitTimeWindow: 60_000,
    },
  })
  const [ingest, traces, detail, spans, sessions, prompts, publish, bySlug] =
    await Promise.all([
      import("../app/api/ingest/route"),
      import("../app/api/traces/route"),
      import("../app/api/traces/[id]/route"),
      import("../app/api/traces/[id]/spans/route"),
      import("../app/api/sessions/route"),
      import("../app/api/prompts/route"),
      import("../app/api/prompts/[id]/publish/route"),
      import("../app/api/prompts/by-slug/[slug]/route"),
    ])
  queue = await import("../src/server/ingestion/queue")
  connection = queue.redisConnection(true)
  worker = (
    await import("../src/server/ingestion/worker")
  ).startIngestionWorker({ connection })
  worker.on("error", () => {})
  listener = await serveWebhook(async (request) => {
    const path = new URL(request.url).pathname
    const post = request.method === "POST"
    if (path === "/api/test/worker" && post) {
      if (request.headers.get("authorization") !== `Bearer ${credential.key}`)
        return new Response(null, { status: 401 })
      const { paused } = await request.json()
      if (paused) await worker!.pause()
      else worker!.resume()
      return Response.json({ data: { paused } })
    }
    if (path === "/api/ingest")
      return post ? ingest.POST(request) : ingest.GET(request)
    if (path === "/api/traces") return traces.GET(request)
    if (path === "/api/sessions" && post) return sessions.POST(request)
    if (path === "/api/prompts" && post) return prompts.POST(request)
    const traceMatch = path.match(/^\/api\/traces\/([^/]+)(\/spans)?$/)
    if (traceMatch) {
      const context = { params: Promise.resolve({ id: traceMatch[1] }) }
      return traceMatch[2]
        ? spans.GET(request, context)
        : detail.GET(request, context)
    }
    const publishMatch = path.match(/^\/api\/prompts\/([^/]+)\/publish$/)
    if (publishMatch && post)
      return publish.POST(request, {
        params: Promise.resolve({ id: publishMatch[1] }),
      })
    const slugMatch = path.match(/^\/api\/prompts\/by-slug\/([^/]+)$/)
    if (slugMatch)
      return bySlug.GET(request, {
        params: Promise.resolve({ slug: slugMatch[1] }),
      })
    return new Response(null, { status: 404 })
  })
  console.info(
    "Python SDK: real authenticated API handlers, Redis, worker, and PostgreSQL ready."
  )
  let wheel = process.env.DATOOL_TEST_PYTHON_WHEEL
  if (wheel) {
    wheel = resolve(wheel)
  } else {
    await run("uv", [
      "build",
      "--project",
      "packages/python-sdk",
      "--out-dir",
      join(directory, "dist"),
    ])
    const wheels = (await readdir(join(directory, "dist"))).filter((name) =>
      name.endsWith(".whl")
    )
    assert.equal(wheels.length, 1, "Expected exactly one Python SDK wheel")
    wheel = join(directory, "dist", wheels[0])
  }
  const python = join(directory, "consumer", "bin", "python")
  await run("uv", [
    "venv",
    "--python",
    process.env.DATOOL_TEST_PYTHON ?? "3.12",
    join(directory, "consumer"),
  ])
  const langgraphRequirements = join(directory, "langgraph-requirements.txt")
  await run("uv", [
    "export",
    "--project",
    "packages/python-sdk",
    "--locked",
    "--only-group",
    "langgraph",
    "--only-group",
    "agents",
    "--no-emit-project",
    "--output-file",
    langgraphRequirements,
  ])
  await run("uv", [
    "pip",
    "install",
    "--python",
    python,
    wheel,
    "-r",
    langgraphRequirements,
  ])
  const reportPath = join(directory, "report.json")
  console.info(
    await run(
      python,
      [resolve("packages/python-sdk/tests/acceptance.py"), reportPath],
      {
        cwd: directory,
        env: {
          ...process.env,
          PYTHONPATH: "",
          LANGSMITH_TRACING: "false",
          LANGCHAIN_TRACING_V2: "false",
          DATOOL_BASE_URL: `http://127.0.0.1:${listener.port}`,
          DATOOL_PROJECT_ID: target.projectId,
          DATOOL_API_KEY: credential.key,
        },
      }
    )
  )
  const report = JSON.parse(await readFile(reportPath, "utf8")) as {
    rootId: string
    agentId: string
    generationId: string
    agentRuns: Array<{ trace_id: string; kind: string; answer: string }>
    failedAgentRuns: string[]
    langgraphModelRuns: Array<{ trace_id: string }>
    langgraphRuns: Array<{
      trace_id: string
      result: { city: string; answer: string }
    }>
  }
  const persisted = await pools.db.query(
    "select id, name, status, session_id, group_name, output_json, attributes_json from traces where project_id=$1 order by name",
    [target.projectId]
  )
  assert.equal(persisted.rows.length, 39)
  assert.ok(persisted.rows.every((row) => row.status !== "running"))
  const root = persisted.rows.find((row) => row.id === report.rootId)!
  assert.equal(root.group_name, "python-assistant")
  assert.deepEqual(JSON.parse(root.output_json), { answer: "22 degrees" })
  assert.equal(root.attributes_json["usage.total_tokens"], 13)
  assert.equal(root.attributes_json["cost.usd"], 0.002)
  const children = await pools.db.query(
    "select id, parent_id, kind, attributes_json from spans where project_id=$1 and trace_id=$2",
    [target.projectId, report.rootId]
  )
  assert.equal(
    children.rows.find((row) => row.id === report.generationId)?.parent_id,
    report.agentId
  )
  assert.equal(
    children.rows.find((row) => row.id === report.generationId)?.kind,
    "llm"
  )
  const graphTraces = persisted.rows.filter(
    (row) => row.name === "langgraph-weather"
  )
  assert.equal(graphTraces.length, 9)
  assert.equal(graphTraces.filter((row) => row.status === "errored").length, 2)
  for (const graphRun of report.langgraphRuns) {
    const graphTrace = graphTraces.find((row) => row.id === graphRun.trace_id)!
    assert.equal(graphTrace.status, "completed")
    assert.equal(graphTrace.attributes_json["datool.span.kind"], "workflow")
    assert.deepEqual(JSON.parse(graphTrace.output_json), graphRun.result)
    const graphSpans: QueryResult<PersistedSpan> = await pools.db.query(
      "select id, name, kind, parent_id, status, input_json, output_json, attributes_json from spans where project_id=$1 and trace_id=$2 order by name",
      [target.projectId, graphRun.trace_id]
    )
    assert.deepEqual(
      graphSpans.rows.map((row) => [row.name, row.kind]),
      [
        ["compose_answer", "task"],
        ["lookup-weather", "tool"],
        ["lookup_weather", "task"],
        ["suggest-activity", "tool"],
        ["suggest_activity", "task"],
      ]
    )
    const nodes = new Map(graphSpans.rows.map((row) => [row.name, row]))
    assert.ok(graphSpans.rows.every((row) => row.status === "completed"))
    for (const name of [
      "compose_answer",
      "lookup_weather",
      "suggest_activity",
    ]) {
      assert.equal(nodes.get(name)?.parent_id, null)
    }
    assert.equal(
      nodes.get("lookup-weather")?.parent_id,
      nodes.get("lookup_weather")?.id
    )
    assert.equal(
      nodes.get("suggest-activity")?.parent_id,
      nodes.get("suggest_activity")?.id
    )
    assert.ok(
      graphSpans.rows.every(
        (row) => row.attributes_json["metadata.framework"] === "langgraph"
      )
    )
    assert.ok(
      graphSpans.rows.every(
        (row) => JSON.parse(row.input_json).city === graphRun.result.city
      )
    )
    assert.deepEqual(JSON.parse(graphSpans.rows[0].output_json), {
      answer: graphRun.result.answer,
    })
  }
  const runningGraphSpans = await pools.db.query(
    "select count(*)::int as count from spans where project_id=$1 and status='running'",
    [target.projectId]
  )
  assert.equal(runningGraphSpans.rows[0].count, 0)
  for (const failedGraph of graphTraces.filter(
    (row) => row.status === "errored"
  )) {
    const failedNode: QueryResult<{
      status: string
      attributes_json: Record<string, unknown>
    }> = await pools.db.query(
      "select status, attributes_json from spans where project_id=$1 and trace_id=$2 and name='lookup-weather'",
      [target.projectId, failedGraph.id]
    )
    assert.equal(failedNode.rows[0]?.status, "errored")
    assert.equal(
      failedNode.rows[0]?.attributes_json["error.type"],
      "ValueError"
    )
  }
  for (const modelRun of report.langgraphModelRuns) {
    const modelTrace = persisted.rows.find(
      (row) => row.id === modelRun.trace_id
    )!
    assert.equal(modelTrace.name, "langgraph-model")
    assert.equal(modelTrace.status, "completed")
    assert.equal(modelTrace.attributes_json["usage.total_tokens"], 14)
    assert.equal(modelTrace.attributes_json["usage.llm_calls"], 1)
    assert.equal(modelTrace.attributes_json["cost.status"], "missing")
    assert.equal(
      JSON.parse(modelTrace.output_json).messages.at(-1).content,
      "It is 22 degrees."
    )
    const modelSpans: QueryResult<PersistedSpan> = await pools.db.query(
      "select id, name, kind, parent_id, status, input_json, output_json, attributes_json from spans where project_id=$1 and trace_id=$2",
      [target.projectId, modelRun.trace_id]
    )
    assert.equal(modelSpans.rows.length, 4)
    const generation = modelSpans.rows.find((row) => row.kind === "llm")!
    const tool = modelSpans.rows.find((row) => row.kind === "tool")!
    assert.equal(
      generation.parent_id,
      modelSpans.rows.find((row) => row.name === "answer")?.id
    )
    assert.equal(
      tool.parent_id,
      modelSpans.rows.find((row) => row.name === "lookup")?.id
    )
    assert.equal(generation.attributes_json["model"], "fixture-weather")
    assert.equal(generation.attributes_json["usage.total_tokens"], 14)
    assert.equal(JSON.parse(generation.input_json)[0][0].role, "user")
    assert.equal(
      JSON.parse(generation.output_json)[0][0].content,
      "It is 22 degrees."
    )
    assert.equal(JSON.parse(tool.input_json).city, "São Paulo")
    assert.equal(JSON.parse(tool.output_json), "São Paulo: 22 degrees")
    assert.ok(modelSpans.rows.every((row) => row.status === "completed"))
  }
  assert.equal(report.agentRuns.length, 14)
  for (const agentRun of report.agentRuns) {
    const agentTrace = persisted.rows.find(
      (row) => row.id === agentRun.trace_id
    )!
    assert.equal(agentTrace.status, "completed")
    assert.equal(agentTrace.attributes_json["datool.span.kind"], "agent")
    assert.equal(
      JSON.parse(agentTrace.output_json).messages.at(-1).content,
      agentRun.answer
    )
    const agentSpans: QueryResult<PersistedSpan> = await pools.db.query(
      "select id, name, kind, parent_id, status, input_json, output_json, attributes_json from spans where project_id=$1 and trace_id=$2",
      [target.projectId, agentRun.trace_id]
    )
    const byId = new Map(agentSpans.rows.map((row) => [row.id, row]))
    const models = agentSpans.rows.filter((row) => row.kind === "llm")
    const tools = agentSpans.rows.filter((row) => row.kind === "tool")
    assert.equal(models.length, agentRun.kind === "deep" ? 6 : 2)
    assert.ok(agentSpans.rows.some((row) => row.kind === "task"))
    if (agentRun.kind === "react") {
      assert.ok(
        agentSpans.rows.some((row) => row.name === "agent" && row.kind === "agent")
      )
      assert.ok(
        agentSpans.rows.some((row) => row.name === "Prompt" && row.kind === "function")
      )
    }
    assert.equal(agentTrace.attributes_json["usage.llm_calls"], models.length)
    assert.equal(agentTrace.attributes_json["usage.status"], "missing")
    assert.ok(agentSpans.rows.every((row) => row.status === "completed"))
    assert.ok(
      agentSpans.rows.every(
        (row) => row.parent_id === null || byId.has(row.parent_id)
      )
    )
    assert.ok(
      models.every(
        (row) => row.attributes_json["model"] === "datool-demo-agent"
      )
    )
    const weather = tools.find((row) => row.name === "weather")!
    assert.deepEqual(JSON.parse(weather.input_json), { city: "São Paulo" })
    assert.equal(JSON.parse(weather.output_json).content, agentRun.answer)
    if (agentRun.kind === "deep") {
      const task = tools.find((row) => row.name === "task")!
      assert.ok(
        agentSpans.rows.some(
          (row) => row.name === "weather-expert" && row.kind === "agent" && row.parent_id === task.id
        )
      )
      const plans = tools.filter((row) => row.name === "write_todos")
      assert.equal(plans.length, 2)
      assert.ok(
        plans.some(
          (row) =>
            JSON.parse(row.output_json).update.todos[0].status === "completed"
        )
      )
      assert.equal(
        JSON.parse(agentTrace.output_json).todos[0].status,
        "completed"
      )
      const ancestors = new Set<string>()
      let parent = weather.parent_id
      while (parent) {
        assert.ok(
          !ancestors.has(parent),
          "Agent span hierarchy contains a cycle"
        )
        ancestors.add(parent)
        parent = byId.get(parent)!.parent_id
      }
      assert.ok(
        ancestors.has(task.id),
        "Delegated tool escaped the parent task trace"
      )
    }
  }
  assert.equal(report.failedAgentRuns.length, 3)
  for (const traceId of report.failedAgentRuns) {
    assert.equal(
      persisted.rows.find((row) => row.id === traceId)?.status,
      "errored"
    )
    const failedModels: QueryResult<
      Pick<PersistedSpan, "status" | "attributes_json">
    > = await pools.db.query(
      "select status, attributes_json from spans where project_id=$1 and trace_id=$2 and kind='llm'",
      [target.projectId, traceId]
    )
    assert.equal(failedModels.rows.length, 1)
    assert.equal(failedModels.rows[0].status, "errored")
    assert.equal(
      failedModels.rows[0].attributes_json["error.type"],
      "ValueError"
    )
  }
  const receipts = await pools.db.query(
    "select count(*)::int as count from ingestion_receipts where project_id=$1",
    [target.projectId]
  )
  assert.ok(receipts.rows[0].count >= 30)
  assert.equal(await queue.getIngestionQueue().getFailedCount(), 0)
  console.info(
    `PASS: clean wheel install persisted ${persisted.rows.length} traces, nested spans, and ${receipts.rows[0].count} receipts; includes 13 automatically traced LangGraph runs with CLI execution, nested tools, model output/usage, node I/O, parentage, concurrent isolation, and error persistence, plus 17 ReAct/create_agent/Deep Agent runs with real tool loops, planning updates, delegated-agent parentage, and failures; worker recovery, auth, prompts, and async/stream lifecycles also passed.`
  )
} finally {
  listener?.stop()
  if (worker) {
    worker.resume()
    await worker.close()
  }
  if (queue) {
    const queueConnection = await queue.getIngestionQueue().backend.client
    await queue.getIngestionQueue().close()
    await queueConnection.quit()
  }
  await connection?.quit()
  if (pools) {
    const { routeCacheRedis } = await import("../src/server/cache/redis")
    await routeCacheRedis()?.quit()
  }
  if (pools) await Promise.all([pools.db.end(), pools.analyticsDb.end()])
  await target?.close()
  for (const container of containers.reverse())
    await docker(["rm", "-f", container])
  await rm(directory, { recursive: true, force: true })
}
