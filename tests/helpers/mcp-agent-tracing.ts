import assert from "node:assert/strict"
import { spyOn } from "bun:test"
import { db } from "@/lib/db"
import { getAuth } from "@/lib/auth"
import { permissionStatements } from "@/src/lib/auth/permissions"
import { brainTool } from "@/src/lib/deploy/contracts"
import { POST } from "@/app/api/project-mcp/[id]/route"
import * as publicHttp from "@/src/server/build/http"
import { createAgent } from "@/src/server/build/agents"
import { saveMcpConnection } from "@/src/server/build/integrations/custom-mcp"
import { runAgentTurn } from "@/src/server/build/runtime"
import { createEveFixture, invokeTool } from "./eve-fixture"
import type { IsolatedPostgres } from "./postgres"

const target = JSON.parse(process.env.TEST_WORKSPACE!) as IsolatedPostgres
const base = process.env.BETTER_AUTH_URL!
const endpoint = `${base}/api/project-mcp/${target.projectId}`
const key = await getAuth().api.createApiKey({
  body: {
    organizationId: target.organizationId,
    userId: target.ownerId,
    name: "MCP loopback fixture",
    permissions: permissionStatements(["build:read", "build:run"]),
    rateLimitMax: 1000,
  },
})
const deploymentId = crypto.randomUUID()
await db.query(
  `INSERT INTO project_deployments(id,project_id,content_hash,bundle_json,tools_json,sandbox_provider)
   VALUES ($1,$2,'mcp-trace-fixture',$3,$4,'local')`,
  [
    deploymentId,
    target.projectId,
    JSON.stringify({ sources: [], skills: [] }),
    JSON.stringify([brainTool]),
  ]
)
await db.query(
  "INSERT INTO project_deployment_state(project_id,organization_id,active_id) VALUES ($1,$2,$3)",
  [target.projectId, target.organizationId, deploymentId]
)
await db.query(
  "INSERT INTO project_brain_chunks(project_id,deployment_id,source_path,title,ordinal,content) VALUES ($1,$2,'company.md','Support',0,'Support opens at nine.')",
  [target.projectId, deploymentId]
)
const received: { body: unknown; headers: Headers; traceId: string | null }[] =
  []
const externalTraceIds: string[] = []
let checkCorrelation = false
let failBrain = false
// Only DNS/network routing is replaced. Auth, MCP transport, runtime and storage are real.
const upstream: typeof fetch = async (input, init) => {
  const request = new Request(input, init)
  assert.equal(request.url, endpoint)
  const body = await request.clone().json()
  const unavailable = failBrain && body.method === "tools/call"
  if (unavailable)
    await db.query(
      "ALTER TABLE project_brain_chunks RENAME TO unavailable_brain_chunks"
    )
  let response: Response
  try {
    response = await POST(request, {
      params: Promise.resolve({ id: target.projectId }),
    })
  } finally {
    if (unavailable)
      await db.query(
        "ALTER TABLE unavailable_brain_chunks RENAME TO project_brain_chunks"
      )
  }
  if (checkCorrelation && body.method === "tools/call") {
    checkCorrelation = false
    const parentId = response.headers.get("x-datool-trace-id")
    for (const kind of ["external", "forged", "changed-body"]) {
      const headers = new Headers(request.headers)
      const changed = { ...body, id: "another-request" }
      if (kind === "external") {
        headers.delete("x-datool-agent-trace")
        headers.set("x-datool-invocation-trace-id", parentId!)
      }
      if (kind === "forged") headers.set("x-datool-agent-trace", "forged-proof")
      const independent = await POST(
        new Request(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(kind === "changed-body" ? changed : body),
        }),
        { params: Promise.resolve({ id: target.projectId }) }
      )
      assert.equal(independent.status, 200)
      const independentId = independent.headers.get("x-datool-trace-id")
      assert(
        independentId && independentId !== parentId,
        `${kind} request incorrectly suppressed its log`
      )
      externalTraceIds.push(independentId)
    }
  }
  received.push({
    body,
    headers: request.headers,
    traceId: response.headers.get("x-datool-trace-id"),
  })
  return response
}
const transport = spyOn(publicHttp, "publicHttpRequest").mockImplementation(
  async (url, options = {}) => {
    const response = await upstream(url, {
      method: options.method,
      headers: options.headers,
      body: options.body as string,
    })
    return {
      url,
      status: response.status,
      headers: response.headers,
      body: new Uint8Array(await response.arrayBuffer()),
    }
  }
)
const eve = await createEveFixture({ target, upstream })
try {
  const agent = await createAgent(eve.context, {
    name: "MCP trace owner",
    configuration: {
      provider: "openai",
      model: "gpt-4.1-mini",
      guardrails: { jevCheckEnabled: false },
    },
  })
  await saveMcpConnection(eve.context, {
    name: "Our MCP",
    agentId: agent.id,
    url: endpoint,
    token: key.key,
  })
  const before = await db.query("SELECT id FROM traces WHERE project_id=$1", [
    target.projectId,
  ])
  received.length = 0
  checkCorrelation = true
  eve.provider((body) =>
    invokeTool(
      body,
      { query: "support" },
      "Support opens at nine.",
      "brain_search"
    )
  )
  const input = {
    agentId: agent.id,
    channel: "api" as const,
    requestKey: "mcp-trace-owner",
    message: "Find support hours",
  }
  const result = await runAgentTurn(eve.context, input)
  assert.equal(result.status, "completed")
  assert.equal(result.toolCalls.length, 1)
  assert.equal(
    result.toolCalls[0].status,
    "completed",
    JSON.stringify(result.toolCalls[0].error)
  )
  assert.match(
    JSON.stringify(result.toolCalls[0].output),
    /Support opens at nine/
  )
  const after = await db.query(
    "SELECT id,operation FROM traces WHERE project_id=$1",
    [target.projectId]
  )
  const newTraces = after.rows.filter(
    (row) =>
      !before.rows.some((old) => old.id === row.id) &&
      !externalTraceIds.includes(row.id)
  )
  assert.deepEqual(
    newTraces.map((row) => row.id),
    [result.traceId],
    "The agent's MCP handshake/tool call created duplicate root logs"
  )
  const spans = await db.query(
    "SELECT kind,input_json,output_json FROM spans WHERE project_id=$1 AND trace_id=$2",
    [target.projectId, result.traceId]
  )
  const toolSpans = spans.rows.filter((row) => row.kind === "tool")
  assert.equal(toolSpans.length, 1, "The same tool was recorded twice")
  assert.match(toolSpans[0].input_json, /support/)
  assert.match(toolSpans[0].output_json, /Support opens at nine/)
  assert(received.length >= 4, "The real MCP handshake was not exercised")
  assert(received.every((call) => call.traceId === result.traceId))
  const replay = await runAgentTurn(eve.context, {
    ...input,
    conversationId: result.conversation.id,
  })
  assert.equal(replay.replayed, true)
  assert.equal(
    (
      await db.query("SELECT count(*) FROM traces WHERE project_id=$1", [
        target.projectId,
      ])
    ).rows[0].count,
    String(after.rows.length)
  )
  failBrain = true
  received.length = 0
  const failed = await runAgentTurn(eve.context, {
    ...input,
    requestKey: "mcp-trace-failure",
  })
  assert.equal(failed.toolCalls[0].status, "failed")
  assert(received.every((call) => call.traceId === failed.traceId))
  const failedSpans = await db.query(
    "SELECT status,output_json FROM spans WHERE project_id=$1 AND trace_id=$2 AND kind='tool'",
    [target.projectId, failed.traceId]
  )
  assert.equal(failedSpans.rows.length, 1)
  assert.equal(failedSpans.rows[0].status, "errored")
  assert.equal(
    (
      await db.query("SELECT count(*) FROM traces WHERE project_id=$1", [
        target.projectId,
      ])
    ).rows[0].count,
    String(after.rows.length + 1)
  )
  console.log("PASS agent MCP trace ownership")
} finally {
  await eve.close()
  transport.mockRestore()
}
