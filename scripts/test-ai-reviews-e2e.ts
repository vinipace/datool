/** Real CLI + MCP over HTTP, against a disposable loopback PostgreSQL schema. */
import assert from "node:assert/strict"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { promisify } from "node:util"
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createServer } from "node:net"
import { makeSignature } from "better-auth/crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "../tests/helpers/postgres"
import { permissionStatements } from "../src/lib/auth/permissions"
import { outputHash } from "../src/lib/tracer/review-annotations"
import type {
  ReviewItemDetail,
  ReviewSessionDetail,
} from "../src/lib/tracer/reviews"

const root = process.cwd()
const execute = promisify(execFile)
const directory = await mkdtemp(join(tmpdir(), "datool-ai-reviews-"))
const appDirectory = join(directory, "app")
const keep = process.argv.includes("--keep")
const target = await createIsolatedPostgres()
let server: ChildProcess | undefined
let pools: typeof import("../lib/db") | undefined
const clients: Client[] = []
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const checks: string[] = []
function passed(message: string) {
  checks.push(message)
  console.info("PASS " + message)
}
async function port() {
  const socket = createServer()
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve))
  const selected = (socket.address() as import("node:net").AddressInfo).port
  await new Promise<void>((resolve) => socket.close(() => resolve()))
  return selected
}
try {
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const base = `http://127.0.0.1:${await port()}`
  Object.assign(process.env, {
    DATABASE_URL: target.databaseUrl,
    BETTER_AUTH_URL: base,
    BETTER_AUTH_SECRET: "isolated-ai-review-test-secret-123456789",
    DATOOL_DATA_DIR: join(directory, "data"),
    NODE_ENV: "development",
  })
  // Keep inherited service credentials and user env files out of the fixture server.
  for (const key of [
    "DATOOL_API_KEY",
    "DATOOL_PROJECT_ID",
    "REDIS_URL",
    "DATOOL_DIST_DIR",
    "ANALYTICS_DATABASE_URL",
  ])
    delete process.env[key]
  pools = await import("../lib/db")
  const { getAuth } = await import("../lib/auth")
  const auth = getAuth()
  const scopes = ["reviews:read", "reviews:write", "traces:read"] as const
  const key = await auth.api.createApiKey({
    body: {
      organizationId: target.organizationId,
      userId: target.ownerId,
      name: "AI review test key",
      permissions: permissionStatements(scopes),
      rateLimitMax: 10000,
    },
  })
  const reader = await auth.api.createApiKey({
    body: {
      organizationId: target.organizationId,
      userId: target.ownerId,
      name: "Review read-only",
      permissions: permissionStatements(["reviews:read"]),
      rateLimitMax: 10000,
    },
  })
  await pools.db.query(
    `insert into traces(id,project_id,name,operation,status,started_at,input_json,output_json)
    values ('brand-test',$1,'Separate brand extraction test','test','completed',$2,'{"response":"No brands are mentioned"}','"Unsupported brand"')`,
    [target.projectId, new Date().toISOString()]
  )
  await pools.db.query(
    `insert into project(id,organization_id,name,slug) values ('other-review-project',$1,'Other test project','other-test')`,
    [target.organizationId]
  )
  const context = await auth.$context
  const session = await context.internalAdapter.createSession(target.ownerId)
  assert(session)
  await pools.db.query(
    'update session set "activeOrganizationId"=$1 where id=$2',
    [target.organizationId, session.id]
  )
  const signature = await makeSignature(session.token, context.secret)
  const cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`
  await mkdir(appDirectory)
  for (const path of [
    "app",
    "components",
    "lib",
    "src",
    "cms",
    "content",
    ".source",
    "public",
    "package.json",
    "tsconfig.json",
    "next-env.d.ts",
    "next.config.ts",
    "postcss.config.mjs",
    "payload.config.ts",
    "payload-types.ts",
    "source.config.ts",
    "proxy.ts",
  ])
    await cp(join(root, path), join(appDirectory, path), { recursive: true })
  await symlink(
    join(root, "node_modules"),
    join(appDirectory, "node_modules"),
    "dir"
  )
  // This route exists only in the disposable copy, for browser inspection of fixture data.
  await mkdir(join(appDirectory, "app", "review-test-login"), {
    recursive: true,
  })
  await writeFile(
    join(appDirectory, "app", "review-test-login", "route.ts"),
    `export function GET(){return new Response(null,{status:302,headers:{"set-cookie":${JSON.stringify(cookie + "; Path=/; HttpOnly; SameSite=Lax")},location:"/p/test-project/reviews"}})}`,
    { mode: 0o600 }
  )
  server = spawn(
    "node",
    [
      join(root, "node_modules/next/dist/bin/next"),
      "dev",
      "--webpack",
      "--hostname",
      "127.0.0.1",
      "--port",
      new URL(base).port,
    ],
    {
      cwd: appDirectory,
      detached: true,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  )
  let serverLog = ""
  for (const stream of [server.stdout, server.stderr])
    stream!.on("data", (chunk) => {
      serverLog = (serverLog + chunk).slice(-24000)
    })
  const headers = (token = key.key, project = target.projectId) => ({
    authorization: `Bearer ${token}`,
    "x-project-id": project,
    "content-type": "application/json",
  })
  async function agent(
    operation: string,
    input: unknown,
    token = key.key,
    project = target.projectId
  ) {
    return fetch(`${base}/api/agent/${operation}`, {
      method: "POST",
      headers: headers(token, project),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(60000),
    })
  }
  let ready = false
  for (let attempt = 0; attempt < 90; attempt++) {
    if (server.exitCode !== null) throw new Error(serverLog)
    try {
      const response = await fetch(
        `${base}/api/agent/describe_agent_operations`,
        {
          method: "POST",
          headers: headers(),
          body: "{}",
          signal: AbortSignal.timeout(1500),
        }
      )
      if (response.ok) {
        ready = true
        break
      }
    } catch {
      /* Wait for compilation of the actual route. */
    }
    await pause(500)
  }
  assert(ready, serverLog)
  const env = {
    ...process.env,
    DATOOL_BASE_URL: base,
    DATOOL_PROJECT_ID: target.projectId,
    DATOOL_API_KEY: key.key,
    DATOOL_CONFIG_DIR: join(directory, "cli"),
  }
  async function cli<T>(args: string[], input?: unknown): Promise<T> {
    const inputFile = join(directory, "input.json")
    if (input !== undefined)
      await writeFile(inputFile, JSON.stringify(input), { mode: 0o600 })
    const result = await execute(
      "node",
      [
        join(root, "packages/cli/dist/datool.js"),
        ...args,
        ...(input === undefined ? [] : ["--input", "@" + inputFile]),
        "--no-env",
      ],
      {
        cwd: directory,
        env,
        timeout: 60000,
        maxBuffer: 8 * 1024 * 1024,
      }
    )
    return result.stdout.trim() ? JSON.parse(result.stdout) : (null as T)
  }
  const discovery = await cli<
    { name: string; inputSchema: { properties: Record<string, unknown> } }[]
  >(["agent", "tools", "record_review"])
  assert(discovery[0].inputSchema.properties.agent)
  const criterion = await cli<{ id: string }>(["human-scores", "create"], {
    score: { name: "Grounding", type: "numeric" },
  })
  const collection = await cli<{ id: string }>(
    ["review-collections", "create"],
    { name: "Separate test rubric", scoreIds: [criterion.id] }
  )
  const review = await cli<ReviewSessionDetail>(["reviews", "create"], {
    name: "CLI and MCP · AI-labelled test",
    traceIds: ["brand-test"],
    collectionId: collection.id,
  })
  assert.equal(
    (await cli<ReviewSessionDetail>(["reviews", "get", review.id])).id,
    review.id
  )
  const itemId = review.items[0].id
  let item = await cli<ReviewItemDetail>([
    "reviews",
    "item",
    review.id,
    "--item-id",
    itemId,
  ])
  assert.equal(item.revision, 0)
  const score = { humanScoreId: criterion.id, humanScoreRevision: 1, value: 0 }
  item = await cli<ReviewItemDetail>(
    ["reviews", "record", review.id, "--item-id", itemId],
    {
      expectedRevision: item.revision,
      notes: "An unsupported brand appears in the output.",
      scores: [score],
      agent: { name: "Codex fixture", model: "test-model" },
    }
  )
  assert.equal(item.label, "AI-labelled")
  assert.equal(item.scores[0].provenance?.principal?.id, key.id)
  assert.equal(item.scores[0].provenance?.authType, "api-key")
  assert.equal(item.reviewedBy, null)
  assert.equal(item.humanVerified, false)
  passed(
    "built CLI discovers, creates, reads and submits AI-labelled scores and notes with a real organization key"
  )
  const beforeNotes = item
  item = await cli<ReviewItemDetail>(
    ["reviews", "record", review.id, "--item-id", itemId],
    {
      expectedRevision: item.revision,
      notes: "Notes-only update preserves completion.",
    }
  )
  assert.deepEqual(item.scores, beforeNotes.scores)
  assert.equal(item.reviewedAt, beforeNotes.reviewedAt)
  passed(
    "CLI notes-only update preserves score values, attribution and completion timestamp"
  )
  const input = {
    sessionId: review.id,
    itemId,
    expectedRevision: item.revision,
    notes: "Denied",
  }
  assert.equal((await agent("record_review", input, reader.key)).status, 403)
  assert.equal(
    (await agent("record_review", input, key.key, "other-review-project"))
      .status,
    404
  )
  assert.equal(
    (await agent("record_review", input, key.key, "unauthorized-project"))
      .status,
    403
  )
  assert.equal(
    (await agent("record_review", { ...input, expectedRevision: 0 })).status,
    409
  )
  assert.equal(
    (
      await agent("record_review", {
        ...input,
        scores: [{ ...score, value: 3 }],
      })
    ).status,
    400
  )
  assert.equal(
    (
      await agent("record_review", {
        ...input,
        source: "human",
        reviewerId: target.ownerId,
      })
    ).status,
    400
  )
  passed(
    "real HTTP rejects missing scope, foreign project/resource, stale revision, invalid score and forged human identity"
  )
  async function connect(token: string) {
    const client = new Client({ name: "ai-review-e2e", version: "1" })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(base + "/api/mcp"), {
        requestInit: { headers: headers(token) },
      })
    )
    clients.push(client)
    return client
  }
  const mcp = await connect(key.key)
  const toolNames = (await mcp.listTools()).tools.map((tool) => tool.name)
  for (const name of [
    "create_review_session",
    "get_review_item",
    "record_review",
    "export_review_items",
  ])
    assert(toolNames.includes(name))
  const mcpCreated = await mcp.callTool({
    name: "create_review_session",
    arguments: {
      name: "Complete MCP AI review test",
      traceIds: ["brand-test"],
      collectionId: collection.id,
    },
  })
  assert(!mcpCreated.isError)
  const mcpReview = (
    mcpCreated.structuredContent as { data: ReviewSessionDetail }
  ).data
  const mcpRead = await mcp.callTool({
    name: "get_review_item",
    arguments: { sessionId: mcpReview.id, itemId: mcpReview.items[0].id },
  })
  assert(!mcpRead.isError)
  const mcpItem = (mcpRead.structuredContent as { data: ReviewItemDetail }).data
  const mcpTrace = await mcp.callTool({
    name: "get_trace",
    arguments: { id: mcpItem.traceId },
  })
  assert(!mcpTrace.isError)
  const mcpRated = await mcp.callTool({
    name: "record_review",
    arguments: {
      sessionId: mcpReview.id,
      itemId: mcpItem.id,
      expectedRevision: mcpItem.revision,
      scores: [score],
      notes: "MCP finding after inspecting evidence",
      agent: { name: "MCP review agent" },
    },
  })
  assert(!mcpRated.isError)
  assert.equal(
    (mcpRated.structuredContent as { data: ReviewItemDetail }).data.scores[0]
      .provenance?.principal?.id,
    key.id
  )
  passed(
    "complete MCP create, evidence read, item read and score/notes submission through API-key authentication"
  )
  const readOnly = await connect(reader.key)
  assert(
    !(await readOnly.listTools()).tools.some(
      (tool) => tool.name === "record_review"
    )
  )
  const denied = await readOnly.callTool({
    name: "record_review",
    arguments: input,
  })
  assert(denied.isError)
  const annotation = {
    id: crypto.randomUUID(),
    comment: "This output is unsupported",
    reference: {
      traceId: "brand-test",
      spanId: null,
      spanName: "Fixture",
      field: "output",
      view: "text",
      outputHash: await outputHash("Unsupported brand"),
      exact: "Unsupported",
      prefix: "",
      suffix: " brand",
      start: 0,
      end: 11,
    },
  }
  const response = await mcp.callTool({
    name: "record_review",
    arguments: {
      sessionId: review.id,
      itemId,
      expectedRevision: item.revision,
      annotations: [annotation],
      agent: { name: "MCP fixture" },
    },
  })
  assert(!response.isError, JSON.stringify(response.content))
  item = (response.structuredContent as { data: ReviewItemDetail }).data
  assert.equal(item.annotations[0].provenance?.label, "AI-labelled")
  assert.equal(item.annotations[0].author.id, key.id)
  assert.equal(item.reviewedAt, beforeNotes.reviewedAt)
  const exported = await mcp.callTool({
    name: "export_review_items",
    arguments: { id: review.id, limit: 1 },
  })
  assert(!exported.isError)
  assert.equal(
    (exported.structuredContent as { data: { items: ReviewItemDetail[] } }).data
      .items[0].humanVerified,
    false
  )
  passed(
    "real MCP HTTP lists scoped tools, submits an attributed annotation and exports AI provenance"
  )
  await cli([
    "reviews",
    "export",
    review.id,
    "--out",
    join(directory, "review.ndjson"),
  ])
  const exportRow = JSON.parse(
    (await readFile(join(directory, "review.ndjson"), "utf8")).trim()
  )
  assert.equal(exportRow.label, "AI-labelled")
  assert.equal(exportRow.notesProvenance.principal.id, key.id)
  assert.equal(exportRow.annotations[0].provenance.authType, "api-key")
  const list = await cli<{ items: ReviewSessionDetail[] }>(["reviews", "list"])
  assert.equal(list.items[0].humanReviewedCount, 0)
  assert.equal(list.items[0].aiReviewedCount, 1)
  passed(
    "CLI NDJSON export and review list preserve explicit AI labels and separate completion counts"
  )
  await writeFile(
    join(directory, "evidence.json"),
    JSON.stringify({ base, reviewId: review.id, itemId, checks }, null, 2)
  )
  console.info(
    JSON.stringify(
      {
        browserLogin: base + "/review-test-login",
        reviewUrl: base + "/p/test-project/reviews/" + review.number,
        directory,
        checks,
      },
      null,
      2
    )
  )
  if (keep) {
    console.info(
      "Keeping the isolated fixture alive for browser verification; Ctrl-C cleans it up."
    )
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve)
      process.once("SIGTERM", resolve)
    })
  }
} finally {
  for (const client of clients) await client.close().catch(() => {})
  if (server?.pid && server.exitCode === null) {
    process.kill(-server.pid, "SIGTERM")
    await Promise.race([
      new Promise((resolve) => server!.once("exit", resolve)),
      pause(5000),
    ])
    if (server.exitCode === null) process.kill(-server.pid, "SIGKILL")
  }
  if (pools) {
    await pools.analyticsDb.end()
    await pools.db.end()
  }
  await target.close()
  await rm(directory, { recursive: true, force: true })
}
