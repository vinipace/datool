/** Disposable browser -> actual API route -> Redis/PostgreSQL proof. */
import { strict as assert } from "node:assert"
import { mkdir, writeFile } from "node:fs/promises"
import { chromium } from "playwright"
import { build } from "esbuild"
import { createIsolatedPostgres, migrateIsolatedPostgres, seedTestWorkspace } from "../tests/helpers/postgres"
import { localEndpoint } from "./read-load/safety"
import { serveWebhook } from "../src/server/apps/webhook"
localEndpoint(process.env.DATOOL_TEST_REDIS_URL ?? "", ["redis:"])
const target = await createIsolatedPostgres()
let server: Awaited<ReturnType<typeof serveWebhook>> | undefined
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let pools: typeof import("../lib/db") | undefined
try {
  await migrateIsolatedPostgres(target); await seedTestWorkspace(target)
  Object.assign(process.env, { DATABASE_URL:target.databaseUrl,REDIS_URL:process.env.DATOOL_TEST_REDIS_URL,
    BETTER_AUTH_URL:"http://localhost:3000",BETTER_AUTH_SECRET:`browser-test-${crypto.randomUUID()}`,DATOOL_BILLING_ENABLED:"false",DATOOL_TRACE_READ_CACHE:"combined" })
  const { getAuth } = await import("../lib/auth")
  pools=await import("../lib/db")
  const key=await getAuth().api.createApiKey({ body:{organizationId:target.organizationId,userId:target.ownerId,name:"Disposable browser verification",permissions:{traces:["read","write"]},rateLimitMax:10000} })
  const route=await import("../app/api/traces/route")
  const built=await build({entryPoints:["components/tracer/api.ts"],platform:"browser",format:"esm",bundle:true,write:false})
  const bundle=built.outputFiles[0].text
  server=await serveWebhook(async request => {
    const path=new URL(request.url).pathname
    if(path==="/api/traces") return request.method==="POST" ? route.POST(request) : route.GET(request)
    if(path==="/client.js") return new Response(bundle,{headers:{"content-type":"text/javascript"}})
    return new Response(`<main data-project-id="${target.projectId}" data-organization-id="${target.organizationId}" data-project-prefix="/p/test"></main><script type="module">import {tracerApi} from '/client.js'; window.traceTestApi=tracerApi;</script>`,{headers:{"content-type":"text/html"}})
  })
  browser=await chromium.launch({headless:true})
  const context=await browser.newContext({extraHTTPHeaders:{authorization:`Bearer ${key.key}`}})
  const page=await context.newPage()
  const statuses:number[]=[]
  page.on("response",response=>{if(new URL(response.url()).pathname==="/api/traces") statuses.push(response.status())})
  await page.goto(`http://127.0.0.1:${server.port}/p/test/traces`)
  await page.waitForFunction(()=>"traceTestApi" in window)
  const initial=await page.evaluate(async()=>{
    const api=(window as unknown as {traceTestApi: typeof import("../components/tracer/api").tracerApi}).traceTestApi
    return api.traces.list({includeTotal:false})
  })
  assert.equal(initial.items.length,0)
  let repeated=await page.evaluate(async()=>{
    const api=(window as unknown as {traceTestApi: typeof import("../components/tracer/api").tracerApi}).traceTestApi
    return api.traces.list({includeTotal:false})
  })
  // The first request may deliberately bypass a still-connecting Redis client.
  for (let attempt=0; attempt<3 && !statuses.includes(304); attempt++) {
    repeated=await page.evaluate(async()=>{
      const api=(window as unknown as {traceTestApi: typeof import("../components/tracer/api").tracerApi}).traceTestApi
      return api.traces.list({includeTotal:false})
    })
  }
  assert.deepEqual(repeated,initial)
  assert(statuses.includes(304),`Real browser did not receive a conditional 304: ${statuses}`)
  const afterWrite=await page.evaluate(async()=>{
    const api=(window as unknown as {traceTestApi: typeof import("../components/tracer/api").tracerApi}).traceTestApi
    const created=await api.traces.create({name:"Browser refresh proof",operation:"test",status:"completed"})
    const refreshed=await api.traces.list({includeTotal:false})
    return {created:created.id,visible:refreshed.items.map(item=>item.id)}
  })
  assert(afterWrite.visible.includes(afterWrite.created),"Mutation did not bypass retained data")
  await context.setExtraHTTPHeaders({})
  const rejected=await page.evaluate(async()=>{
    try {
      const api=(window as unknown as {traceTestApi: typeof import("../components/tracer/api").tracerApi}).traceTestApi
      await api.traces.list({includeTotal:false}); return false
    } catch {return true}
  })
  assert(rejected,"Browser reused private data after authorization failed")
  assert(statuses.includes(401) || statuses.includes(403),`Expected authorization denial: ${statuses}`)
  const report={initialEmpty:true,conditional304:true,retainedDataEqual:true,mutationImmediatelyVisible:true,unauthorizedReadRejected:true,statuses}
  await mkdir("artifacts/trace-refresh",{recursive:true})
  await writeFile("artifacts/trace-refresh/browser.json",JSON.stringify(report,null,2))
  console.info(JSON.stringify(report))
} finally {
  await browser?.close();server?.stop()
  const {routeCacheRedis}=await import("../src/server/cache/redis")
  await routeCacheRedis()?.quit();await pools?.db.end();await pools?.analyticsDb.end();await target.close()
}
