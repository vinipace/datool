import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createTracer, createDatool } from "@datool/sdk"
import { DatoolSpanProcessor } from "@datool/sdk/otel"
import { withDatoolCall } from "@datool/sdk/context"

const require = createRequire(import.meta.url)
assert.equal(typeof require("@datool/sdk").createTracer, "function")
assert.equal(typeof require("@datool/sdk/otel").DatoolSpanProcessor, "function")
const run = promisify(execFile)
const requests = []
const server = createServer(async (request, response) => {
  let body = ""
  for await (const chunk of request) body += chunk
  requests.push({
    path: request.url,
    headers: request.headers,
    body: body ? JSON.parse(body) : undefined,
  })
  response.setHeader("content-type", "application/json")
  const input = body ? JSON.parse(body) : {}
  if (request.url.startsWith("/api/prompts/by-slug/brand")) {
    const version = Number(new URL(request.url, "http://fixture").searchParams.get("version")) || 1
    response.end(JSON.stringify({data: {id:"prompt-brand",slug:"brand",name:"Brand",description:"",metadata:{},provider:"vercel-ai-gateway",model:"openai/gpt-4.1-mini",messages:[{role:"user",content:"Hello {{name}}"}],template:"mustache",output:"text",version}}))
    return
  }
  if (request.url === "/api/agent/gate_eval_run") {
    response.end(
      JSON.stringify({
        data: { passed: false, reasons: ["Fixture gate failure"] },
      })
    )
    return
  }
  response.end(JSON.stringify({ data: { id: input.id, ...input } }))
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
try {
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const options = {
    baseUrl,
    projectId: "packed-project",
    apiKey: "fixture",
    delivery: "direct",
  }
  const datool = createDatool(options)
  const prompt = await datool.prompts.get("brand")
  assert.equal(prompt.render({name:"<Ada>"})[0].content, "Hello <Ada>")
  await datool.prompts.withScope({brand:{version:2,model:"experiment"}},async () => {
    assert.equal((await datool.prompts.get("brand")).version,2)
    assert.equal((await datool.prompts.get("brand")).model,"experiment")
  })
  assert.equal((await datool.prompts.get("brand")).version,1)
  const tracer = createTracer(options)
  await tracer.workflow(
    {
      name: "packed",
      group: { type: "workflow", name: "packed", version: "v1" },
    },
    async (trace) => trace.agent({ name: "reviewer" }, () => ({ passed: true }))
  )
  assert(requests.some((request) => request.body?.group?.name === "packed"))
  assert(requests.some((request) => request.body?.group?.name === "reviewer"))
  const processor = new DatoolSpanProcessor({ ...options, pricing: { autoRefresh: false } })
  const span = {
    name: "packed-otel",
    attributes: {},
    startTime: [1, 0],
    endTime: [2, 0],
    status: { code: 1 },
    spanContext: () => ({ traceId: "otel-trace", spanId: "otel-span" }),
  }
  withDatoolCall(
    { connectionId: "packed-connection", callId: "packed-call" },
    () => processor.onStart(span)
  )
  processor.onEnd(span)
  await processor.shutdown()
  assert(
    requests.some(
      (request) =>
        request.body?.attributes?.["datool.call.id"] === "packed-call"
    )
  )
  const { stdout } = await run("node", [
    "node_modules/@datool/cli/dist/datool.js",
    "--version",
  ])
  const manifest = JSON.parse(
    await readFile("node_modules/@datool/cli/package.json", "utf8")
  )
  assert.equal(stdout.trim(), manifest.version)
  await run(
    "node",
    [
      "node_modules/@datool/cli/dist/datool.js",
      "connect",
      "http://127.0.0.1:9/call",
      "--datool",
      baseUrl,
      "--project",
      "packed-project",
    ],
    { env: { ...process.env, DATOOL_API_KEY: "fixture" } }
  )
  assert(
    requests.some(
      (request) =>
        request.path === "/api/apps/config" &&
        request.body?.[0]?.connection?.type === "webhook" &&
        request.body[0].connection.url === "http://127.0.0.1:9/call"
    )
  )
  const cliArgs = ["node_modules/@datool/cli/dist/datool.js"]
  const cliEnv = {
    env: {
      ...process.env,
      DATOOL_API_KEY: "fixture",
      DATOOL_PROJECT_ID: "packed-project",
      DATOOL_BASE_URL: baseUrl,
    },
  }
  const queried = await run(
    "node",
    [
      ...cliArgs,
      "traces",
      "list",
      "--limit",
      "3",
      "--filter",
      'status = "errored"',
    ],
    cliEnv
  )
  assert.equal(JSON.parse(queried.stdout).limit, 3)
  assert(
    requests.some(
      (request) =>
        request.path === "/api/agent/list_traces" &&
        request.body.filter === 'status = "errored"'
    )
  )
  await run(
    "node",
    [...cliArgs, "datasets", "snapshot", "dataset-id", "--label", "packed"],
    cliEnv
  )
  assert(
    requests.some(
      (request) =>
        request.path === "/api/agent/create_dataset_snapshot" &&
        request.body.datasetId === "dataset-id"
    )
  )
  await assert.rejects(
    run(
      "node",
      [...cliArgs, "evals", "gate", "run-id", "--min-score", "0.8"],
      cliEnv
    ),
    (error) => error.code === 2 && JSON.parse(error.stdout).passed === false
  )
  for (const request of requests)
    assert.equal(request.headers["x-project-id"], "packed-project")
  console.info(
    "PASS: manual tracing, OTel/shared context, CLI executable and project headers from tarballs."
  )
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
