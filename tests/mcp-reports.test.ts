import { afterAll, beforeAll, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { WorkspaceScope } from "../src/lib/auth/permissions"
import type { ReportDocumentInput } from "../src/lib/tracer/report-mdx"
import type { Report, ReportSummary } from "../src/lib/tracer/reports"
import { createMcpServer } from "../src/server/mcp/server"
import { routeScopes } from "../src/server/auth/request"
import type { TracerDatabase } from "../src/server/tracer/db"
import { TracerService } from "../src/server/tracer/service"
import { seedEvalAttributionFacts } from "./helpers/eval-attribution-fixture"
import {
  createTracerFixture,
  closeTracerFixture,
} from "./helpers/tracer-fixture"

let db: TracerDatabase
let client: Client
async function connect(scopes: WorkspaceScope[]) {
  const client = new Client({ name: "report-author", version: "1" })
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair()
  await createMcpServer(new TracerService(db), scopes).connect(serverTransport)
  await client.connect(clientTransport)
  return client
}
async function call<T>(
  name: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError).not.toBe(true)
  return (result.structuredContent as { data: T }).data
}
beforeAll(async () => {
  db = await createTracerFixture()
  await seedEvalAttributionFacts(db, 2, 3)
  client = await connect([
    "dashboards:read",
    "dashboards:write",
    "metrics:read",
  ])
})
afterAll(async () => {
  await client?.close()
  if (db) await closeTracerFixture(db)
})

test("an MCP agent discovers, authors, saves and retrieves an immutable report", async () => {
  const guide = await call<{
    id: string
    workflow: { step: number; call?: string; calls?: string[] }[]
    validationScope: Record<string, string>
    componentExamples: { name: string; mdx: string }[]
  }>("get_report_authoring_guide")
  expect(guide.id).toBe("mdx-report-authoring")
  expect(guide.workflow.map((step) => step.step)).toEqual([1, 2, 3, 4, 5, 6, 7])
  expect(guide.workflow.some((step) => step.call === "validate_report")).toBe(true)
  for (const scope of ["structural", "data", "render", "visual", "responsive"])
    expect(typeof guide.validationScope[scope]).toBe("string")
  expect(guide.componentExamples.map((example) => example.name)).toContain(
    "Bound metric"
  )
  const recipe = await call<{ id: string; format: string }>("get_report_recipe")
  expect(recipe.id).toBe("evaluation-story")
  expect(recipe.format).toBe("mdx")
  const catalog = await call<{ components: { name: string }[] }>(
    "get_report_components"
  )
  expect(catalog.components.map((c) => c.name)).toContain("Comparison")
  const template = await call<{ document: ReportDocumentInput }>(
    "get_report_template",
    {
      id: "evaluation-comparison",
      asOf: new Date(Date.now() + 1000).toISOString(),
    }
  )
  const input = {
    ...template.document,
    name: "Agent evaluation report",
    creationKey: crypto.randomUUID(),
  }
  const valid = await call<{
    valid: boolean
    checks: {
      structural: string
      data: string
      render: string
      visual: string
      responsive: string
    }
    render: { status: string; renderer: string }
  }>("validate_report", {
    document: template.document,
  })
  expect(valid.valid).toBe(true)
  expect(valid.checks).toEqual({
    structural: "passed",
    data: "passed",
    render: "passed",
    visual: "not-run",
    responsive: "not-run",
  })
  expect(valid.render).toMatchObject({
    status: "passed",
    renderer: "react-dom/server",
  })
  const report = await call<Report>("create_report", input)
  expect(report.number).toBe(1)
  expect(report.document?.mdx).toBe(input.mdx)
  expect(report.mdx?.version).toBe(1)
  expect(report.snapshot.results.length).toBeGreaterThan(0)
  for (const result of report.snapshot.results)
    expect(result.meta.page.total).toBe(result.data.length)
  expect(new Set(report.snapshot.results.map((r) => r.meta.asOf)).size).toBe(1)
  for (const mdx of [
    "<Unknown />",
    '<Chart source="absent" type="bar" />',
    '{fetch("/api/reports")}',
  ]) {
    const bad = await call<{ valid: boolean }>("validate_report", {
      document: { ...template.document, mdx },
    })
    expect(bad.valid).toBe(false)
  }
  const summaries = await call<ReportSummary[]>("list_reports")
  expect(summaries[0]).toMatchObject({ number: 1, name: input.name })
  for (const key of [String(report.number), report.id]) {
    const link = await call<{ path: string; linkKind: string; id: string }>(
      "resolve_report",
      { key }
    )
    expect(link.id).toBe(report.id)
    expect(link.linkKind).toBe("detail")
    expect(link.path.endsWith("/reports/1")).toBe(true)
  }
  // The agent reads the same captured evidence after the source has changed.
  await db.execute(sql`update scores set value=1`)
  await db.execute(sql`delete from eval_results`)
  expect(await call<Report>("get_report", { number: 1 })).toEqual(report)
  expect(await call<Report>("create_report", input)).toEqual(report)
  expect(await call<ReportSummary[]>("list_reports")).toHaveLength(1)
  const conflict = await client.callTool({
    name: "create_report",
    arguments: {
      ...input,
      name: "Different report",
    },
  })
  expect(conflict.isError).toBe(true)
  expect(JSON.stringify(conflict.content)).toContain("CONFLICT")
  expect(
    (
      await client.callTool({
        name: "set_report_presentation",
        arguments: { number: report.number, revision: 0, presentation: null },
      })
    ).isError
  ).toBe(true)
}, 30000)

test("report tools enforce read/write/metric permissions and strict input", async () => {
  for (const scopes of [
    ["dashboards:read"],
    ["dashboards:read", "metrics:read"],
    ["dashboards:write"],
  ] as WorkspaceScope[][]) {
    const restricted = await connect(scopes)
    try {
      const { tools } = await restricted.listTools()
      expect(tools.some((t) => t.name === "create_report")).toBe(false)
      expect(tools.some((t) => t.name === "set_report_presentation")).toBe(
        false
      )
      expect(tools.some((t) => t.name === "get_report")).toBe(
        scopes.includes("metrics:read")
      )
      expect(
        (await restricted.callTool({ name: "create_report", arguments: {} }))
          .isError
      ).toBe(true)
    } finally {
      await restricted.close()
    }
  }
  for (const number of [0, -1, 1.5, "1"]) {
    expect(
      (await client.callTool({ name: "get_report", arguments: { number } }))
        .isError
    ).toBe(true)
  }
  expect(
    (
      await client.callTool({
        name: "get_report_template",
        arguments: { id: "missing" },
      })
    ).isError
  ).toBe(true)
  for (const [name, scopes] of [
    ["create_report", ["dashboards:write", "metrics:read"]],
    ["get_report", ["dashboards:read", "metrics:read"]],
    ["resolve_report", ["dashboards:read", "metrics:read"]],
  ] as const) {
    expect(
      await routeScopes(
        new Request(`http://localhost/api/agent/${name}`, { method: "POST" })
      )
    ).toEqual([...scopes])
  }
})

test("an MCP agent drafts, edits, publishes and explicitly shares a report", async () => {
  const draft = await call<Report>("create_report", {
    creationKey: crypto.randomUUID(),
    name: "Draft lifecycle",
    description: "Synthetic lifecycle proof",
    mdx: "Ready for review",
    sources: {},
    bindings: {},
  })
  expect(draft.status).toBe("draft")
  const edited = await call<Report>("update_report", {
    number: draft.number,
    revision: draft.revision,
    document: { ...draft.document!, name: "Reviewed via MCP" },
  })
  expect(edited.name).toBe("Reviewed via MCP")
  const published = await call<Report>("publish_report", {
    number: edited.number,
    revision: edited.revision,
  })
  expect(published.publicPath).toBeNull()
  const forbidden = await client.callTool({
    name: "update_report",
    arguments: {
      number: published.number,
      revision: published.revision,
      document: { ...draft.document!, name: "No edits" },
    },
  })
  expect(forbidden.isError).toBe(true)
  const reader = await connect(["dashboards:read", "metrics:read"])
  const denied = await reader.callTool({
    name: "set_report_sharing",
    arguments: {
      number: published.number,
      revision: published.revision,
      enabled: true,
    },
  })
  expect(denied.isError).toBe(true)
  await reader.close()
  const shared = await call<Report>("set_report_sharing", {
    number: published.number,
    revision: published.revision,
    enabled: true,
  })
  expect(shared.publicPath?.startsWith("/share/reports/")).toBe(true)
  const copy = await call<Report>("clone_report", {
    number: published.number,
    creationKey: crypto.randomUUID(),
  })
  expect(copy.status).toBe("draft")
  expect(copy.publicPath).toBeNull()
  expect(copy.snapshot).toEqual(published.snapshot)
  const revoked = await call<Report>("set_report_sharing", {
    number: published.number,
    revision: shared.revision,
    enabled: false,
  })
  expect(revoked.publicPath).toBeNull()
})
