import { build } from "esbuild"
import { serve } from "bun"
import { readFile } from "node:fs/promises"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "../../helpers/postgres"
import {
  createTracerDatabase,
  closeTracerDatabase,
} from "@/src/server/tracer/db"
import { TracerService } from "@/src/server/tracer/service"
import { runTracerEffect } from "@/src/server/tracer/effect"
import { createTraceExplorerServer } from "@/src/server/mcp/trace-explorer"
import { handleMcp } from "@/src/server/mcp/http"
const target = await createIsolatedPostgres()
await migrateIsolatedPostgres(target)
await seedTestWorkspace(target)
const database = createTracerDatabase(target.databaseUrl, {
  projectId: target.projectId,
  schema: target.schema,
})
const service = new TracerService(database)
for (let index = 0; index < 28; index++) {
  await runTracerEffect(
    service.createTrace({
      id: `fixture-trace-${index}`,
      name: index ? `Fixture request ${index}` : "Agent checkout investigation",
      operation: "fixture",
      status: index % 2 ? "completed" : "errored",
      startedAt: new Date(
        Date.parse("2026-09-29T12:00:00Z") - index * 6e4
      ).toISOString(),
      endedAt: new Date(
        Date.parse("2026-09-29T12:00:05Z") - index * 6e4
      ).toISOString(),
    })
  )
}
for (const [index, name, kind, status] of [
  [0, "Agent request", "agent", "errored"],
  [1, "Retrieve checkout context", "tool", "completed"],
  [2, "Generate checkout answer", "llm", "errored"],
]) {
  await runTracerEffect(
    service.createSpan("fixture-trace-0", {
      id: `fixture-span-${index}`,
      parentId: index ? "fixture-span-0" : null,
      name,
      kind,
      status,
      startedAt: `2026-09-29T12:00:0${index}Z`,
      endedAt: "2026-09-29T12:00:05Z",
      input: { question: "Synthetic checkout question", fixture: true },
      output:
        index === 2
          ? { error: "Synthetic provider timeout" }
          : { result: "Synthetic fixture output" },
      attributes: { fixture: true },
    })
  )
}
const bundle = await build({
  entryPoints: ["tests/fixtures/mcp-apps/host.ts"],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
})
const html =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Datool MCP Apps fixture</title></head><body><h1>Datool fixture host</h1><p>Synthetic data only. This local harness tests the real MCP Apps bridge, not ChatGPT authentication.</p><button id="reset">Reset traces</button> <button id="empty">Empty state</button> <button id="fail">Fail next read</button> <button id="delay">Delay next read</button><p id="calls">Server calls: 0</p><iframe allow="clipboard-write" id="app" title="Datool Trace Explorer" style="width:100%;height:780px;border:0"></iframe><pre id="received" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre><script type="module" src="/host.js"><\/script></body></html>'
const port = Number(process.env.DATOOL_FIXTURE_PORT ?? 8766)
const config = {
  resource: `http://127.0.0.1:${port}/rpc`,
  issuer: `http://127.0.0.1:${port}/auth`,
  jwksUrl: `http://127.0.0.1:${port}/jwks`,
  origins: [],
  scopes: ["traces:read"],
}
const server = serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const pathname = new URL(request.url).pathname
    if (pathname === "/rpc" && request.method === "POST")
      return handleMcp(request, {
        config: () => config,
        authenticate: async () => ({
          subject: target.ownerId,
          projectId: target.projectId,
          organizationId: target.organizationId,
          scopes: ["traces:read"],
        }),
        service: async () => service,
        createServer: (service2) => createTraceExplorerServer(service2, config),
      })
    if (pathname === "/host.js")
      return new Response(bundle.outputFiles[0].text, {
        headers: { "Content-Type": "text/javascript" },
      })
    if (pathname === "/app.html")
      return new Response(
        await readFile("public/mcp-apps/trace-explorer.html"),
        {
          headers: {
            "Content-Type": "text/html",
            "Content-Security-Policy":
              "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; worker-src 'none'",
          },
        }
      )
    return new Response(html, { headers: { "Content-Type": "text/html" } })
  },
})
console.log(`Fixture host ready at ${server.url}. All data is synthetic.`)
async function close() {
  server.stop()
  await closeTracerDatabase(database)
  await target.close()
  process.exit(0)
}
process.on("SIGINT", () => {
  void close()
})
process.on("SIGTERM", () => {
  void close()
})
