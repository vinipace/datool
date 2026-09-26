/** Real authenticated route handlers, built Node CLI, MCP and disposable local fixtures. */
import assert from "node:assert/strict"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "../tests/helpers/postgres"
import {
  permissionStatements,
  workspaceScopes,
} from "../src/lib/auth/permissions"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type {
  EvalRunDetail,
  DatasetItem,
  Span,
} from "../src/lib/tracer/contracts"

const execute = promisify(execFile)
const directory = await mkdtemp(join(tmpdir(), "datool-workflow-proof-"))
const target = await createIsolatedPostgres()
let listener: ChildProcess | undefined
let server: { stop(): void; port: number } | undefined
let pools: typeof import("../lib/db") | undefined
let mcp: Client | undefined
let bridgeLog = ""
try {
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  Object.assign(process.env, {
    DATABASE_URL: target.databaseUrl,
    BETTER_AUTH_SECRET: "local-workflow-fixture-secret-123456789",
    NODE_ENV: "development",
    DATOOL_DATA_DIR: join(directory, "data"),
  })
  const { serveWebhook } = await import("../src/server/apps/webhook")
  const agentRoute = await import("../app/api/agent/[operation]/route")
  const configRoute = await import("../app/api/apps/config/route")
  const registerRoute = await import("../app/api/apps/bridges/route")
  const exchangeRoute = await import("../app/api/apps/bridges/exchange/route")
  let credential = ""
  let lostClaim = false,
    longCooldown = false,
    lostAck = false
  let readFaults = 0,
    interruptedPage = false
  const requests = new Map<string, string>()
  let firstClaimId = "",
    ackId = "",
    throttleAt = 0,
    resumedAt = 0
  server = await serveWebhook(async (request) => {
    const path = new URL(request.url).pathname
    if (path === "/api/apps/config") return configRoute.POST(request)
    if (path === "/api/apps/bridges") return registerRoute.POST(request)
    if (path === "/api/apps/bridges/exchange") {
      const body = await request.clone().json()
      const previous = requests.get(body.requestId)
      if (previous)
        assert.equal(
          JSON.stringify(body),
          previous,
          "retry changed exchange body"
        )
      requests.set(body.requestId, JSON.stringify(body))
      if (lostClaim && !longCooldown && body.requestId !== firstClaimId) {
        longCooldown = true
        throttleAt = Date.now()
        // A task completes while this identical empty exchange waits longer than
        // BOTH the previous 30s lease and 60s job deadline.
        return Response.json(
          { error: { details: { retryAfterSeconds: 65 } } },
          { status: 429, headers: { "Retry-After": "65" } }
        )
      }
      if (longCooldown && !resumedAt) {
        resumedAt = Date.now()
        assert(resumedAt - throttleAt >= 65_000)
      }
      const response = await exchangeRoute.POST(request)
      if (!response.ok) return response
      const value = await response.clone().json()
      if (!lostClaim && value.data.jobs.length) {
        lostClaim = true
        firstClaimId = body.requestId
        return new Response("interrupted-json", { status: 200 })
      }
      if (!lostAck && value.data.acknowledged.length) {
        lostAck = true
        ackId = body.requestId
        return new Response("interrupted-json", { status: 200 })
      }
      return response
    }
    if (path.startsWith("/api/agent/")) {
      const operation = path.split("/").at(-1)!
      const input = await request.clone().json()
      if (operation === "get_eval_run" && readFaults > 0) {
        readFaults--
        return Response.json(
          { error: { details: { retryAfterSeconds: 0.2 } } },
          { status: 429, headers: { "Retry-After": "0.2" } }
        )
      }
      const result = await agentRoute.POST(request, {
        params: Promise.resolve({ operation }),
      })
      if (
        operation === "get_eval_run" &&
        input.cursor &&
        input.includeEvidence &&
        !interruptedPage
      ) {
        interruptedPage = true
        return new Response("interrupted-json", { status: 200 })
      }
      return result
    }
    return new Response(null, { status: 404 })
  })
  const base = `http://127.0.0.1:${server.port}`
  process.env.BETTER_AUTH_URL = base
  pools = await import("../lib/db")
  const { getAuth } = await import("../lib/auth")
  credential = (
    await getAuth().api.createApiKey({
      body: {
        organizationId: target.organizationId,
        userId: target.ownerId,
        name: "Disposable workflow verification",
        permissions: permissionStatements(workspaceScopes),
        rateLimitMax: 100_000,
        rateLimitTimeWindow: 60_000,
      },
    })
  ).key
  const env = {
    ...process.env,
    DATOOL_BASE_URL: base,
    DATOOL_PROJECT_ID: target.projectId,
    DATOOL_API_KEY: credential,
    DATOOL_CONFIG_DIR: directory,
  }
  const cliPath = resolve("packages/cli/dist/datool.js")
  async function cli(args: string[], input?: unknown) {
    const file = join(directory, "input.json")
    if (input !== undefined) await writeFile(file, JSON.stringify(input))
    const result = await execute(
      "node",
      [
        cliPath,
        ...args,
        ...(input === undefined ? [] : ["--input", `@${file}`]),
      ],
      { env, cwd: directory, maxBuffer: 24 * 1024 * 1024, timeout: 180_000 }
    )
    try {
      return result.stdout.trim() ? JSON.parse(result.stdout) : null
    } catch {
      throw new Error(
        `Invalid CLI JSON from ${args.slice(0, 2).join(" ")} (${result.stdout.length} characters)`
      )
    }
  }
  const { createTracerDatabase, closeTracerDatabase } =
    await import("../src/server/tracer/db")
  const { TracerService } = await import("../src/server/tracer/service")
  const { runTracerEffect: run } = await import("../src/server/tracer/effect")
  const { createMcpServer } = await import("../src/server/mcp/server")
  const { defaultScorer } = await import("../src/lib/tracer/scorers")
  const database = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
    schema: target.schema,
  })
  try {
    const service = new TracerService(database)
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    mcp = new Client({ name: "workflow-proof", version: "1" })
    await createMcpServer(service, workspaceScopes).connect(serverTransport)
    await mcp.connect(clientTransport)
    const dataset = await cli(["datasets", "create"], {
      name: "100 native cases",
    })
    await cli(["datasets", "bulk", dataset.id], {
      create: Array.from({ length: 10 }, (_, n) => ({
        id: `original-${n}`,
        input: { n },
        expectedOutput: { n },
        metadata: { reviewed: true },
      })),
    })
    const baseline = await cli(["datasets", "snapshot", dataset.id])
    const original = (
      await cli([
        "datasets",
        "version",
        dataset.id,
        "--version-id",
        baseline.id,
      ])
    ).items
    // Migration compatibility: materialize a pre-change JSON artifact; same reader.
    await pools.db.query(
      "INSERT INTO dataset_snapshots(id,project_id,dataset_id,content_hash,item_count,content_json,created_at) VALUES($1,$2,$3,'legacy-fixture',10,$4,$5)",
      [
        "legacy-fixture",
        target.projectId,
        dataset.id,
        JSON.stringify({
          ...(await service.agent.snapshotArtifact(dataset.id, baseline.id)),
          items: original,
        }),
        new Date().toISOString(),
      ]
    )
    assert.deepEqual(
      (
        await cli([
          "datasets",
          "version",
          dataset.id,
          "--version-id",
          "legacy-fixture",
        ])
      ).items,
      original
    )
    console.info("PASS built CLI legacy snapshot and original references")
    const selections: {
      id: string
      traceId: string
      spanId: string
      expectedOutput: { n: number }
    }[] = []
    for (let n = 10; n < 100; n++) {
      const trace = await run(
        service.createTrace({
          name: `production ${n}`,
          status: "completed",
          attributes: { payload: "a".repeat(40_000), model: "fixture" },
        })
      )
      const span: Span = await run(
        service.createSpan(trace.id, {
          name: "extract",
          status: "completed",
          input: { n },
          output: { n },
          attributes: { payload: "b".repeat(40_000), version: "fixture-v1" },
        })
      )
      selections.push({
        id: `promoted-${n}`,
        traceId: trace.id,
        spanId: span.id,
        expectedOutput: { n },
      })
    }
    await assert.rejects(
      cli(["datasets", "promote", dataset.id], {
        spans: selections,
        preview: true,
      }),
      /HTTP 413/
    )
    for (let start = 0; start < 90; start += 10) {
      const spans = selections.slice(start, start + 10)
      const preview = await cli(["datasets", "promote", dataset.id], {
        spans,
        preview: true,
      })
      const saved = await cli(["datasets", "promote", dataset.id], {
        spans,
        preview: false,
        expectedEvidenceHash: preview.evidenceHash,
      })
      assert.equal(saved.created.length, 10)
    }
    const bytes = Number(
      (
        await pools.db.query(
          "SELECT sum(octet_length(source_span_evidence_json)) AS bytes FROM dataset_items WHERE project_id=$1",
          [target.projectId]
        )
      ).rows[0].bytes
    )
    assert(bytes > 8 * 1024 * 1024)
    console.info(`PASS native promotion: ${bytes} evidence bytes`)
    const snapshot = await cli(["datasets", "snapshot", dataset.id])
    assert.equal(snapshot.itemCount, 100)
    assert.equal(
      (await cli(["datasets", "snapshot", dataset.id])).id,
      snapshot.id
    )
    const frozen: DatasetItem[] = []
    let cursor: string | undefined
    do {
      const result = await mcp.callTool({
        name: "get_dataset_snapshot",
        arguments: {
          datasetId: dataset.id,
          versionId: snapshot.id,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        },
      })
      assert(!result.isError)
      const page = (
        result.structuredContent as {
          data: { items: DatasetItem[]; nextCursor: string | null }
        }
      ).data
      assert(Buffer.byteLength(JSON.stringify(page)) <= 8 * 1024 * 1024)
      frozen.push(...page.items)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    assert.equal(frozen.length, 100)
    assert.deepEqual(
      frozen.filter((item) => item.id.startsWith("original")),
      original
    )
    assert.equal(
      frozen[10].sourceSpanEvidence?.provenance?.trace.attributes.payload,
      "a".repeat(40_000)
    )
    await run(
      service.patchSpan(selections[0].spanId, {
        output: "changed live source",
        attributes: { changed: true },
      })
    )
    await cli(["datasets", "edit", selections[0].id], {
      patch: { expectedOutput: "changed live reference", input: { n: -1 } },
    })
    const scorer = await cli(["scorers", "create"], {
      scorer: {
        ...defaultScorer,
        name: "Local evidence judge",
        slug: "local-evidence-judge",
        type: "javascript",
        code: `function evaluate({trace,datasetItem}) {
      if (trace.input.n === 99) throw new Error("intentional fixture judge failure");
      if (datasetItem.sourceSpanId && (datasetItem.sourceSpanEvidence.provenance.trace.attributes.payload.length !== 40000 || datasetItem.sourceSpanEvidence.output.n !== datasetItem.expectedOutput.n)) throw new Error("captured evidence changed");
      return {score: trace.input.n === 97 ? 0 : Number(trace.output.n === datasetItem.expectedOutput.n), reason: "saved reasoning " + trace.input.n};
    }`,
      },
    })
    await writeFile(join(directory, "package.json"), '{"type":"module"}')
    await writeFile(
      join(directory, "datool.config.ts"),
      `import { appendFile } from "node:fs/promises";
export default { apps: [{id:"local-extract",name:"Local extract",inputSchema:{type:"object",required:["n"],properties:{n:{type:"number"}},additionalProperties:false},outputSchema:{type:"object"},handler:async input=>{
  await appendFile(${JSON.stringify(join(directory, "calls.ndjson"))},JSON.stringify(input)+"\\n");
  await new Promise(resolve=>setTimeout(resolve,1000));
  if(input.n===98) throw new Error("intentional fixture app failure");
  return {n:input.n};
}}]}`
    )
    listener = spawn("node", [cliPath, "connect", "--no-env"], {
      cwd: directory,
      env,
      stdio: "pipe",
    })
    listener.stdout!.on("data", (chunk) => {
      bridgeLog += chunk
    })
    listener.stderr!.on("data", (chunk) => {
      bridgeLog += chunk
    })
    for (let i = 0; i < 200 && !bridgeLog.includes("Listening for"); i++) {
      assert.equal(listener.exitCode, null, bridgeLog)
      await delay(50)
    }
    assert(bridgeLog.includes("Listening for"), bridgeLog)
    console.info(
      "PASS immutable snapshot pages via MCP; starting connected execution"
    )
    const runInput = {
      mode: "connected",
      appId: "local-extract",
      datasetId: dataset.id,
      datasetVersionId: snapshot.id,
      evaluatorIds: [scorer.id],
      requestKey: "100-case-native-proof",
      concurrency: 4,
    }
    const started = await cli(["evals", "run"], runInput)
    assert.equal((await cli(["evals", "run"], runInput)).id, started.id)
    readFaults = 1
    // A short interrupted wait is resumable and never starts another run.
    await assert.rejects(
      cli(["evals", "wait", started.id, "--timeout", "0.1"]),
      (error) => (error as { code: number }).code === 3
    )
    readFaults = 1
    await cli([
      "evals",
      "wait",
      started.id,
      "--timeout",
      "180",
      "--poll-interval",
      "1",
    ])
    readFaults = 1
    const output = join(directory, "results.ndjson")
    await cli([
      "evals",
      "export",
      started.id,
      "--include-evidence",
      "--out",
      output,
    ])
    const rows = (await readFile(output, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as NonNullable<EvalRunDetail["rows"]>
    console.info(
      JSON.stringify({
        exportedRows: rows.length,
        reasonings: rows.filter((row) => row.results[0]?.reasoning).length,
        errors: rows
          .filter((row) => row.results[0]?.error)
          .map((row) => ({
            case: row.datasetCaseId,
            error: row.results[0].error,
          })),
      })
    )
    assert.equal(rows.length, 100)
    assert.equal(new Set(rows.map((row) => row.id)).size, 100)
    assert(
      rows.filter((row) =>
        row.results[0].reasoning?.startsWith("saved reasoning")
      ).length >= 98,
      "Expected saved reasoning for every successful local judge execution"
    )
    assert.equal(
      rows.find(
        (row) =>
          row.trace.input &&
          typeof row.trace.input === "object" &&
          "n" in row.trace.input &&
          row.trace.input.n === 97
      )?.results[0].score,
      0
    )
    assert(
      rows.some((row) =>
        JSON.stringify(row).includes("intentional fixture app failure")
      )
    )
    assert(
      rows.some((row) =>
        JSON.stringify(row).includes("intentional fixture judge failure")
      )
    )
    const calls = (await readFile(join(directory, "calls.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).n)
    assert.equal(calls.length, 100)
    assert.equal(new Set(calls).size, 100)
    assert(!calls.includes(-1))
    assert(
      lostClaim && longCooldown && lostAck && interruptedPage,
      JSON.stringify({ lostClaim, longCooldown, lostAck, interruptedPage })
    )
    assert(firstClaimId && ackId && resumedAt - throttleAt >= 65_000)
    assert(bridgeLog.includes("Bridge throttled"))
    const result = await mcp.callTool({
      name: "get_eval_target",
      arguments: { id: started.id, targetId: rows[10].id },
    })
    assert(!result.isError)
    const spanEvidence = JSON.stringify(result.structuredContent)
    assert(spanEvidence.includes("saved reasoning"))
    assert(spanEvidence.includes("payload"))
    console.info(
      JSON.stringify(
        {
          passed: true,
          cases: 100,
          sourceEvidenceBytes: bytes,
          snapshot: snapshot.id,
          run: started.id,
          uniqueAppExecutions: calls.length,
          cooldownMs: resumedAt - throttleAt,
          lostClaimResponse: lostClaim,
          lostAcknowledgment: lostAck,
          interruptedExportPage: interruptedPage,
          fullResultRows: rows.length,
          preservedOriginalCases: original.length,
        },
        null,
        2
      )
    )
  } finally {
    await mcp?.close()
    mcp = undefined
    await closeTracerDatabase(database)
  }
} finally {
  if (listener && listener.exitCode === null) {
    listener.kill("SIGTERM")
    for (let i = 0; i < 100 && listener.exitCode === null; i++) await delay(100)
    if (listener.exitCode === null) listener.kill("SIGKILL")
  }
  server?.stop()
  await Promise.all([pools?.db.end(), pools?.analyticsDb.end()])
  await target.close()
  await rm(directory, { recursive: true, force: true })
}
