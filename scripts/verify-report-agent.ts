/** Local HTTP proof using real MCP and the built Node CLI. Saves two demo reports. */
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  serializeReportFile,
  type ReportDocumentInput,
} from "../src/lib/tracer/report-mdx"
import {
  reportInputSchema,
  type Report,
  type ReportInput,
  type ReportSummary,
} from "../src/lib/tracer/reports"

const origin = process.env.DATOOL_BASE_URL ?? "http://localhost:3000"
assert(
  ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname),
  "Use a local demo server"
)
const projectId = process.env.DATOOL_PROJECT_ID
const key = process.env.DATOOL_API_KEY
assert(
  projectId && key?.startsWith("dtk_"),
  "Set DATOOL_PROJECT_ID and a scoped organization DATOOL_API_KEY"
)
const execute = promisify(execFile)
async function cli<T>(...args: string[]): Promise<T> {
  const { stdout } = await execute(
    "node",
    [
      resolve("packages/cli/dist/datool.js"),
      "--no-env",
      ...args,
      "--datool",
      origin,
      "--project",
      projectId!,
    ],
    {
      env: process.env,
      timeout: 150_000,
      maxBuffer: 16 * 1024 * 1024,
    }
  )
  return JSON.parse(stdout) as T
}
const client = new Client({ name: "report-verification-agent", version: "1" })
async function mcp<T>(
  name: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 120_000,
  })
  assert(!result.isError, JSON.stringify(result.content))
  return (result.structuredContent as { data: T }).data
}
const hash = (report: Report) =>
  createHash("sha256").update(JSON.stringify(report.snapshot)).digest("hex")
const directory = resolve("artifacts/report-agent-proof")
async function savedInput(
  path: string,
  input: ReportInput
): Promise<ReportInput> {
  try {
    return reportInputSchema.parse(JSON.parse(await readFile(path, "utf8")))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    await writeFile(path, JSON.stringify(input, null, 2), { flag: "wx" })
    return input
  }
}
await mkdir(directory, { recursive: true })
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/api/mcp", origin), {
      requestInit: {
        headers: { Authorization: `Bearer ${key}`, "X-Project-Id": projectId },
      },
    }),
    { timeout: 120_000 }
  )
  const discovered = await client.listTools()
  for (const name of [
    "list_report_templates",
    "get_report_template",
    "create_report",
    "get_report",
    "list_reports",
    "resolve_report",
  ])
    assert(
      discovered.tools.some((tool) => tool.name === name),
      `Missing MCP tool: ${name}`
    )
  assert(
    (await cli<{ id: string }[]>("reports", "templates")).some(
      (t) => t.id === "evaluation-comparison"
    )
  )
  const template = await mcp<{ id: string; document: ReportDocumentInput }>(
    "get_report_template",
    { id: "evaluation-comparison" }
  )
  const input = {
    ...template.document,
    creationKey: randomUUID(),
    name: "Agent proof · MCP MDX report",
  }
  const catalog = await mcp<{ components: { name: string }[] }>(
    "get_report_components"
  )
  assert(catalog.components.some((c) => c.name === "Comparison"))
  assert(
    (
      await mcp<{ valid: boolean }>("validate_report", {
        document: template.document,
      })
    ).valid
  )
  const inputPath = resolve(directory, "mcp-report-input.json")
  const persistedInput = await savedInput(inputPath, input)
  const first = await mcp<Report>("create_report", persistedInput)
  assert.equal(first.mdx?.version, 1)
  assert.equal(first.status, "draft")
  // Time charts may expand into a main query and a baseline query.
  assert(first.snapshot.results.length >= 5)
  for (const result of first.snapshot.results) {
    assert(result.data.length > 0, "Seed evaluation data before verification")
    assert.equal(result.meta.page.total, result.data.length)
  }
  assert.equal(new Set(first.snapshot.results.map((r) => r.meta.asOf)).size, 1)
  assert.deepEqual(
    await cli<Report>("reports", "get", String(first.number)),
    first
  )
  // Same exact input, different transport: returns the original, no duplicate capture.
  assert.deepEqual(
    await cli<Report>("reports", "create", "--input", `@${inputPath}`),
    first
  )
  const secondInput = {
    ...input,
    creationKey: randomUUID(),
    name: "Agent proof · CLI MDX report",
  }
  const secondPath = resolve(directory, "cli-report-input.json")
  const persistedSecond = await savedInput(secondPath, secondInput)
  const file = resolve(directory, "report.mdx")
  const { creationKey: secondKey, ...document } = persistedSecond
  await writeFile(file, serializeReportFile(document))
  assert(
    (await cli<{ valid: boolean }>("reports", "validate", "--file", file)).valid
  )
  const second = await cli<Report>(
    "reports",
    "create",
    "--file",
    file,
    "--creation-key",
    secondKey
  )
  assert.notEqual(second.id, first.id)
  assert.deepEqual(
    await mcp<Report>("get_report", { number: second.number }),
    second
  )
  const listed = await mcp<ReportSummary[]>("list_reports")
  assert(
    listed.some((report) => report.id === first.id) &&
      listed.some((report) => report.id === second.id)
  )
  const links = await Promise.all(
    [first, second].map((report) =>
      cli<{ path: string; url: string }>(
        "reports",
        "resolve",
        String(report.number)
      )
    )
  )
  const proof = [first, second].map((report, index) => ({
    number: report.number,
    name: report.name,
    url: links[index].url,
    frozenAt: report.frozenAt,
    widgets: report.widgetCount,
    queryRows: report.snapshot.results.map((result) => result.data.length),
    snapshotSha256: hash(report),
  }))
  await writeFile(
    resolve(directory, "proof.json"),
    JSON.stringify({ passed: true, reports: proof }, null, 2)
  )
  console.log(JSON.stringify({ passed: true, reports: proof }, null, 2))
} finally {
  await client.close()
}
