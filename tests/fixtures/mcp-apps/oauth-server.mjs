import { serve } from "bun"
import { makeSignature } from "better-auth/crypto"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "../../helpers/postgres"
const origin = new URL(process.env.DATOOL_FIXTURE_ORIGIN ?? "")
if (
  origin.protocol !== "https:" ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash
)
  throw new Error("DATOOL_FIXTURE_ORIGIN must be the temporary HTTPS origin.")
const target = await createIsolatedPostgres()
await migrateIsolatedPostgres(target)
await seedTestWorkspace(target)
process.env.DATABASE_URL = target.databaseUrl
process.env.BETTER_AUTH_URL = origin.origin
process.env.BETTER_AUTH_SECRET = crypto.randomUUID() + crypto.randomUUID()
const { getAuth } = await import("../../../lib/auth")
const { db, analyticsDb } = await import("../../../lib/db")
const { getTracerService } = await import("../../../src/server/tracer/service")
const { runTracerEffect } = await import("../../../src/server/tracer/effect")
const mcp = await import("../../../app/api/mcp/trace-explorer/route")
const resource =
  await import("../../../app/.well-known/oauth-protected-resource/api/mcp/trace-explorer/route")
const authorization = await import("../../../app/api/mcp/authorization/route")
const auth = getAuth()
const context = await auth.$context
const session = await context.internalAdapter.createSession(target.ownerId)
if (!session) throw new Error("Could not create synthetic fixture session")
const cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(session.token + "." + (await makeSignature(session.token, context.secret)))}; Path=/; HttpOnly; Secure; SameSite=Lax`
const service = await getTracerService(target.projectId)
await runTracerEffect(
  service.createTrace({
    id: "fixture-chatgpt-trace",
    name: "Synthetic checkout timeout",
    operation: "fixture",
    status: "errored",
    startedAt: "2026-09-29T12:00:00Z",
    endedAt: "2026-09-29T12:00:05Z",
  })
)
for (const [index, name, kind, status] of [
  [0, "Agent request", "agent", "errored"],
  [1, "Retrieve checkout context", "tool", "completed"],
  [2, "Generate checkout answer", "llm", "errored"],
])
  await runTracerEffect(
    service.createSpan("fixture-chatgpt-trace", {
      id: `fixture-chatgpt-span-${index}`,
      parentId: index ? "fixture-chatgpt-span-0" : null,
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
const consentScript = `const query=new URLSearchParams(location.search);document.querySelector('#approve').onclick=async()=>{const r=await fetch('/api/mcp/authorization',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:location.pathname.endsWith('/connect')?'continue':'consent',projectId:${JSON.stringify(target.projectId)},oauth_query:query.toString(),accept:true})});const body=await r.json();if(r.ok&&body.data.url)location.assign(body.data.url);else document.querySelector('#error').textContent=body.error?.message??'Authorization failed'};`
const page = (content, script = "") =>
  new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Datool synthetic developer fixture</title><body><h1>Datool synthetic developer fixture</h1><p>Disposable synthetic account and traces. No customer data.</p>${content}<p id="error" role="alert"></p>${script ? `<script>${script}<\/script>` : ""}</body></html>`,
    { headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } }
  )
const server = serve({
  hostname: "127.0.0.1",
  port: 8766,
  async fetch(incoming) {
    const url = new URL(incoming.url)
    const request = new Request(
      new URL(url.pathname + url.search, origin),
      incoming
    )
    if (url.pathname === "/api/mcp/trace-explorer")
      return incoming.method === "OPTIONS"
        ? mcp.OPTIONS(request)
        : mcp.POST(request)
    if (
      url.pathname ===
      "/.well-known/oauth-protected-resource/api/mcp/trace-explorer"
    )
      return resource.GET()
    if (url.pathname === "/.well-known/oauth-authorization-server/api/auth")
      return auth.handler(
        new Request(
          `${origin.origin}/api/auth/.well-known/oauth-authorization-server`
        )
      )
    if (url.pathname.startsWith("/api/auth/")) return auth.handler(request)
    if (url.pathname === "/api/mcp/authorization")
      return incoming.method === "POST"
        ? authorization.POST(request)
        : authorization.GET(request)
    if (url.pathname === "/sign-in")
      return page(
        '<button id="login">Use synthetic fixture account</button>',
        `document.querySelector('#login').onclick=()=>{const p=new URLSearchParams(location.search);const returnTo=p.has('client_id')&&p.get('response_type')==='code'?'/api/auth/oauth2/authorize?'+p.toString():p.get('redirectTo')??p.get('callbackURL')??'/';location.assign('/fixture/sign-in?returnTo='+encodeURIComponent(returnTo))}`
      )
    if (url.pathname === "/fixture/sign-in") {
      const destination = new URL(
        url.searchParams.get("returnTo") ?? "/",
        origin
      )
      if (destination.origin !== origin.origin)
        return new Response("Invalid return URL", { status: 400 })
      return new Response(null, {
        status: 302,
        headers: { "Set-Cookie": cookie, Location: destination.href },
      })
    }
    if (url.pathname === "/mcp/connect" || url.pathname === "/mcp/consent")
      return page(
        '<p>Project: Test project. Access: trace read only, with token refresh if requested.</p><button id="approve">Allow synthetic project access</button>',
        consentScript
      )
    return page("<p>Ready for personal ChatGPT developer registration.</p>")
  },
})
console.log(
  `Synthetic OAuth fixture ready on ${server.url}. MCP path /api/mcp/trace-explorer.`
)
async function close() {
  server.stop()
  await db.end()
  await analyticsDb.end()
  await target.close()
  process.exit(0)
}
process.on("SIGINT", () => {
  void close()
})
process.on("SIGTERM", () => {
  void close()
})
