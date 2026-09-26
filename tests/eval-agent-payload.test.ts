import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type {
  EvalRunComparison,
  EvalRunDetail,
} from "../src/lib/tracer/contracts"
import { serveWebhook } from "../src/server/apps/webhook"
import { findAgentOperation } from "../src/server/mcp/operations"
import { createMcpServer } from "../src/server/mcp/server"
import { getTracerProjectId } from "../src/server/tracer/db"
import { runTracerEffect as run } from "../src/server/tracer/effect"
import { asTracerError } from "../src/server/tracer/errors"
import { evalRuns, evalRunTargets } from "../src/server/tracer/schema"
import { TracerService } from "../src/server/tracer/service"
import {
  closeTracerFixture,
  createTracerFixture,
  scopeRows,
} from "./helpers/tracer-fixture"

type Target = NonNullable<EvalRunDetail["rows"]>[number]

test("CLI and MCP page oversized evals without spans and fetch one frozen target on demand", async () => {
  const db = await createTracerFixture()
  const service = new TracerService(db)
  const server = createMcpServer(service, ["evals:read"])
  const client = new Client({ name: "eval-payload", version: "1" })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const dir = await mkdtemp(join(tmpdir(), "datool-eval-agent-"))
  // Exercise the real CLI process through the same operation dispatcher as agent HTTP.
  const requests: { name: string; input: Record<string, unknown> }[] = []
  const http = await serveWebhook(async (request) => {
    expect(request.headers.get("x-project-id")).toBe(getTracerProjectId(db))
    expect(request.headers.get("authorization")).toBe("Bearer eval-test-only")
    const name = new URL(request.url).pathname.split("/").at(-1)!
    const input = await request.json()
    requests.push({ name, input })
    const operation = findAgentOperation(name)!
    expect(operation.scopes).toEqual(["evals:read"])
    try {
      return Response.json({
        data: await run(operation.execute(service, input)),
      })
    } catch (error) {
      const problem = asTracerError(error)
      return Response.json(
        { error: { code: problem.code, message: problem.message } },
        { status: 400 }
      )
    }
  })
  const cli = async (...args: string[]) => {
    const bundle = process.env.DATOOL_TEST_CLI_BIN
    const { stdout, stderr } = await promisify(execFile)(
      bundle ? "node" : process.execPath,
      bundle ? [bundle, "evals", ...args] : ["--no-env-file", "bin/datool.ts", "evals", ...args],
      {
        env: {
          ...process.env,
          DATOOL_NO_ENV: "1",
          DATOOL_BASE_URL: `http://127.0.0.1:${http.port}`,
          DATOOL_PROJECT_ID: getTracerProjectId(db),
          DATOOL_API_KEY: "eval-test-only",
        },
        maxBuffer: 16 * 1024 * 1024,
      }
    )
    return stdout ? JSON.parse(stdout) : JSON.parse(stderr)
  }
  const mcp = async <T>(
    name: string,
    args: Record<string, unknown>
  ): Promise<T> => {
    const response = await client.callTool({ name, arguments: args })
    expect(response.isError).not.toBe(true)
    return (response.structuredContent as { data: T }).data
  }
  try {
    const trace = await run(
      service.createTrace({
        name: "Payload case",
        input: "Saved input",
        output: "Saved output",
        status: "completed",
      })
    )
    const time = "2026-09-18T00:00:00Z"
    const frozenSpan = {
      id: "frozen-span",
      traceId: trace.id,
      parentId: null,
      name: "Frozen span",
      kind: "llm",
      status: "completed",
      startedAt: time,
      endedAt: time,
      attributes: {},
      input: "x".repeat(220_000),
      output: "Saved span output",
    }
    expect(Buffer.byteLength(JSON.stringify(frozenSpan)) * 50).toBeGreaterThan(
      8 * 1024 * 1024
    )
    await db.insert(evalRuns).values(
      scopeRows(
        db,
        ["left", "right"].map((id) => ({
          id,
          status: "completed",
          createdAt: time,
        }))
      )
    )
    for (const side of ["left", "right"]) {
      await db.insert(evalRunTargets).values(
        scopeRows(
          db,
          Array.from({ length: 60 }, (_, ordinal) => ({
            id: `${side}-${ordinal}`,
            runId: side,
            traceId: trace.id,
            ordinal,
            createdAt: time,
            snapshotJson: JSON.stringify({
              trace: { ...trace, input: { ordinal }, spans: [frozenSpan] },
              datasetItem: null,
            }),
          }))
        )
      )
    }
    await server.connect(a)
    await client.connect(b)
    const tools = (await client.listTools()).tools
    expect(
      tools.find((tool) => tool.name === "get_eval_target")?.annotations
        ?.readOnlyHint
    ).toBe(true)
    expect(
      tools.find((tool) => tool.name === "get_eval_run")?.inputSchema.properties
        ?.includeEvidence
    ).toMatchObject({ type: "boolean", default: false })
    const first = await mcp<EvalRunDetail>("get_eval_run", { id: "left" })
    expect(first.rows).toHaveLength(50)
    expect(first.rows![0].scoringTrace).toBeUndefined()
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(100_000)
    const last = await mcp<EvalRunDetail>("get_eval_run", {
      id: "left",
      cursor: first.nextCursor,
    })
    expect(last.rows).toHaveLength(10)
    expect(last.nextCursor).toBeNull()
    const comparison = await mcp<EvalRunComparison>("compare_eval_runs", {
      leftId: "left",
      rightId: "right",
    })
    expect(comparison.pairs).toHaveLength(50)
    expect(comparison.pairs[0].left?.scoringTrace).toBeUndefined()
    expect(comparison.pairs[0].right?.scoringTrace).toBeUndefined()
    expect(comparison.nextOffset).toBe(50)
    const target = await mcp<Target>("get_eval_target", {
      id: "left",
      targetId: "left-0",
    })
    expect(target.scoringTrace?.spans[0].input).toBe(frozenSpan.input)
    const embedded = await mcp<EvalRunDetail>("get_eval_run", {
      id: "left",
      limit: 1,
      includeEvidence: true,
    })
    expect(embedded.rows![0].scoringTrace?.spans[0].input).toBe(
      frozenSpan.input
    )
    expect(
      (
        await client.callTool({
          name: "get_eval_target",
          arguments: { id: "right", targetId: "left-0" },
        })
      ).isError
    ).toBe(true)

    const cliPage = (await cli("get", "left", "--limit", "50")) as EvalRunDetail
    expect(cliPage.rows).toHaveLength(50)
    expect(cliPage.rows![0].scoringTrace).toBeUndefined()
    const cliTarget = (await cli(
      "target",
      "left",
      "--target-id",
      "left-0"
    )) as Target
    expect(cliTarget.scoringTrace?.spans[0].input).toBe(frozenSpan.input)
    const cliEmbedded = (await cli(
      "get",
      "left",
      "--limit",
      "1",
      "--include-evidence"
    )) as EvalRunDetail
    expect(cliEmbedded.rows![0].scoringTrace?.spans[0].input).toBe(
      frozenSpan.input
    )
    expect(requests.at(-1)?.input.includeEvidence).toBe(true)
    const cliComparison = (await cli(
      "compare",
      "--left-id",
      "left",
      "--right-id",
      "right",
      "--include-evidence",
      "false"
    )) as EvalRunComparison
    expect(cliComparison.pairs).toHaveLength(50)
    expect(cliComparison.pairs[0].left?.scoringTrace).toBeUndefined()
    expect(requests.at(-1)?.input.includeEvidence).toBe(false)
    const waited = (await cli("wait", "left")) as EvalRunDetail
    expect(waited.status).toBe("completed")
    expect(waited.rows![0].scoringTrace).toBeUndefined()
    expect(requests.at(-1)?.input).toEqual({
      id: "left",
      limit: 1,
      includeEvidence: false,
    })
    const out = join(dir, "evals.ndjson")
    const exported = await cli(
      "export",
      "left",
      "--out",
      out,
      "--max-rows",
      "60"
    )
    expect(exported.complete).toBe(true)
    const rows = (await readFile(out, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Target)
    expect(rows).toHaveLength(60)
    expect(new Set(rows.map((row) => row.id)).size).toBe(60)
    expect(rows.every((row) => row.scoringTrace === undefined)).toBe(true)
  } finally {
    http.stop()
    await client.close()
    await server.close()
    await closeTracerFixture(db)
    await rm(dir, { recursive: true, force: true })
  }
}, 60_000)
