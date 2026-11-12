import { verifyProjectPostgres } from "./project-postgres"
import { createServer } from "node:http"
import assert from "node:assert/strict"
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { getAuth } from "../../lib/auth"
import { db } from "../../lib/db"
import { permissionStatements } from "../../src/lib/auth/permissions"
import { GET, POST } from "../../app/api/deployments/route"
import { POST as mcpPOST } from "../../app/api/project-mcp/route"
import {
  POST as deploymentMcpPOST,
  OPTIONS as mcpOPTIONS,
} from "../../app/api/project-mcp/[id]/route"
import { packDeployment } from "../../bin/deploy"
import { getRuntimeAppliedDefinitions } from "../../src/server/build/definitions"
import { createTracerDatabase } from "../../src/server/tracer/db"
import { storageFixture } from "./drive-storage"
import {
  saveStorageConnection,
  removeStorageConnection,
} from "../../src/server/build/storage/connections"
import {
  deployProject,
  invokeDeploymentTool,
} from "../../src/server/deploy/service"

const directory = await mkdtemp(join(tmpdir(), "datool-deploy-source-"))
const project = process.env.TEST_PROJECT!,
  organization = process.env.TEST_ORGANIZATION!
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    const request = new Request(
      `http://127.0.0.1:${(server.address() as { port: number }).port}${incoming.url}`,
      {
        method: incoming.method,
        headers: incoming.headers as Record<string, string>,
        ...(["GET", "HEAD"].includes(incoming.method!)
          ? {}
          : { body: Buffer.concat(chunks) }),
      }
    )
    const path = new URL(request.url).pathname
    const response =
      path === "/api/deployments"
        ? await (request.method === "GET" ? GET(request) : POST(request))
        : path === "/api/project-mcp"
          ? await mcpPOST(request)
          : path.startsWith("/api/project-mcp/")
            ? request.method === "OPTIONS"
              ? mcpOPTIONS(request)
              : await deploymentMcpPOST(request, {
                  params: Promise.resolve({ id: path.split("/").at(-1)! }),
                })
            : new Response(null, { status: 404 })
    outgoing.writeHead(response.status, Object.fromEntries(response.headers))
    outgoing.end(Buffer.from(await response.arrayBuffer()))
  } catch {
    outgoing.writeHead(500)
    outgoing.end()
  }
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
const key = await getAuth().api.createApiKey({
  body: {
    organizationId: organization,
    userId: process.env.TEST_OWNER!,
    name: "Deploy test",
    permissions: permissionStatements([
      "build:read",
      "build:write",
      "build:run",
    ]),
    rateLimitMax: 1000,
  },
})
const readKey = await getAuth().api.createApiKey({
  body: {
    organizationId: organization,
    userId: process.env.TEST_OWNER!,
    name: "Read test",
    permissions: permissionStatements(["build:read"]),
    rateLimitMax: 1000,
  },
})
const headers = {
  Authorization: `Bearer ${key.key}`,
  "x-project-id": project,
  "content-type": "application/json",
}
const request = (
  path: string,
  body?: unknown,
  overrides?: Record<string, string>
) =>
  fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...headers, ...overrides },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const cli = (args: string[] = [], projectId = project) =>
  promisify(execFile)(
    process.execPath,
    ["--no-env-file", "bin/datool.ts", "deploy", ...args, "--no-env"],
    {
      env: {
        ...process.env,
        DATOOL_BASE_URL: origin,
        DATOOL_PROJECT_ID: projectId,
        DATOOL_API_KEY: key.key,
      },
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    }
  )
const client = new Client({ name: "deployment-test", version: "1" })
try {
  for (const path of ["tools", "sources", "skills", "agents/foo"])
    await mkdir(join(directory, path), { recursive: true })
  await writeFile(
    join(directory, "agents/foo/instructions.md"),
    "Use the company brain and deployed tools."
  )
  await writeFile(
    join(directory, "skills/research.md"),
    "# Research\nFind company policies before answering."
  )
  await writeFile(
    join(directory, "sources/company.md"),
    "Our company makes bicycles in Portugal."
  )
  await writeFile(
    join(directory, "sources/fetch_sources.ts"),
    "export default async () => [{path:'policy.md',title:'Returns policy',text:'Bicycle returns are accepted within thirty days.'}]"
  )
  const toolFile = join(directory, "tools/records.ts")
  const source = `export default {
    description: 'Manage example records', inputSchema: {type:'object',properties:{mode:{type:'string'}},required:['mode'],additionalProperties:false},
    async execute(input, ctx) {
      if (input.mode === 'write') {
        await ctx.db.set('projects','one',{name:'Bicycle',status:'active'},0);
        await ctx.bucket.put('notes/company.txt','hello');
        const shell = await ctx.sandbox.run('printf sandbox-ok');
        return {shell:shell.stdout, secret:process.env.DATOOL_HOST_SECRET ?? null};
      }
      if (input.mode === 'read') return {record:await ctx.db.get('projects','one'),file:(await ctx.bucket.get('notes/company.txt'))?.data.toString() ?? null};
      if (input.mode === 'conflict') return ctx.db.set('projects','one',{bad:true},0);
      if (input.mode === 'escape') return ctx.fetch('http://127.0.0.1:3000');
      if (input.mode === 'list') return ctx.db.list('projects',{where:{status:'active'}});
      if (input.mode === 'delete') {await ctx.db.delete('projects','one',1);await ctx.bucket.delete('notes/company.txt');return true;}
      return 'v1';
    }
  }`
  await writeFile(toolFile, source)
  const git = (args: string[]) =>
    promisify(execFile)("git", args, { cwd: directory })
  await git(["init", "-b", "feature/deployment-ui"])
  await git(["add", "tools", "sources", "skills", "agents"])
  await git([
    "-c",
    "user.name=Deployment Test",
    "-c",
    "user.email=deployment@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Publish bicycle company tools",
  ])
  const preview = JSON.parse((await cli([directory, "--dry-run"])).stdout)
  assert.deepEqual(preview.tools, ["records"])
  assert.equal((await request("/api/deployments")).status, 200)
  assert.equal(
    (
      await request(
        "/api/deployments",
        {},
        { Authorization: `Bearer ${readKey.key}` }
      )
    ).status,
    403
  )
  const deployed = JSON.parse((await cli([directory])).stdout)
  assert.equal(deployed.mcpPath, `/api/project-mcp/${project}`)
  const rpcBody = { jsonrpc: "2.0", id: 1, method: "tools/list" }
  const challenge = await request(deployed.mcpPath, rpcBody, {
    Authorization: "",
    Origin: "http://127.0.0.1:3000",
  })
  assert.equal(challenge.status, 401)
  assert.match(
    challenge.headers.get("www-authenticate")!,
    /resource_metadata="http:\/\/127\.0\.0\.1:3000\/\.well-known\/oauth-protected-resource"/
  )
  assert.match(
    challenge.headers.get("access-control-expose-headers")!,
    /WWW-Authenticate/
  )
  const legacy = await request(
    `/api/project-mcp?projectId=${project}&environment=production`,
    rpcBody,
    { Accept: "application/json, text/event-stream" }
  )
  assert.equal(legacy.status, 200)
  for (const path of [
    deployed.mcpPath,
    `/api/project-mcp/${deployed.id.replaceAll("-", "")}`,
  ]) {
    assert.equal(
      (await request(path, rpcBody, { Authorization: `Bearer ${readKey.key}` }))
        .status,
      403
    )
    assert.equal(
      (await request(path, rpcBody, { "x-project-id": crypto.randomUUID() }))
        .status,
      403
    )
    assert.equal(
      (await request(path + "?projectId=" + crypto.randomUUID(), rpcBody))
        .status,
      403
    )
    assert.equal(
      (await request(path, rpcBody, { Origin: "https://evil.example" })).status,
      403
    )
  }
  assert.equal(
    (await request(deployed.mcpPath + "?environment=preview", rpcBody)).status,
    400
  )
  const preflight = await fetch(origin + deployed.mcpPath, {
    method: "OPTIONS",
    headers: {
      Origin: "http://127.0.0.1:3000",
      "Access-Control-Request-Method": "POST",
    },
  })
  assert.equal(preflight.status, 204)
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    "http://127.0.0.1:3000"
  )
  assert.equal(deployed.unchanged, false)
  assert.equal(deployed.title, "Publish bicycle company tools")
  assert.equal(deployed.branch, "feature/deployment-ui")
  assert.equal(deployed.dirty, false)
  assert.match(deployed.commit, /^[a-f0-9]{40}$/)
  assert.ok(deployed.durationMs > 0)

  // The UI reads the published snapshot with Build read permission only.
  const readView = async (
    query: Record<string, string>,
    projectId = project
  ) => {
    const response = await request(
      `/api/deployments?${new URLSearchParams(query as Record<string, string>)}`,
      undefined,
      {
        Authorization: `Bearer ${readKey.key}`,
        "x-project-id": projectId,
      }
    )
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("cache-control"), "no-store")
    return (await response.json()).data
  }
  const firstDetail = await readView({ view: "detail", id: deployed.id })
  assert.equal(firstDetail.active, true)
  assert.deepEqual(
    firstDetail.tools.find((tool: { name: string }) => tool.name === "records")
      .inputSchema.required,
    ["mode"]
  )
  assert.equal(
    firstDetail.documents.find(
      (doc: { path: string }) => doc.path === "sources/company.md"
    ).characters,
    39
  )
  assert.deepEqual(firstDetail.collectors, ["fetch_sources"])
  const firstSource = await readView({
    view: "source",
    id: deployed.id,
    kind: "source",
    path: "sources/company.md",
  })
  assert.equal(firstSource.text, "Our company makes bicycles in Portugal.")
  assert.match(
    (
      await readView({
        view: "source",
        id: deployed.id,
        kind: "skill",
        path: "skills/research.md",
      })
    ).text,
    /Find company policies/
  )
  // Metadata must not expose executable bundles or provider configuration.
  assert.deepEqual(Object.keys(firstDetail).sort(), [
    "active",
    "collectors",
    "deployment",
    "documents",
    "tools",
  ])
  assert.equal("text" in firstDetail.documents[0], false)
  for (const query of [
    "view=unknown",
    "view=history&cursor=invalid",
    "view=history&limit=51",
    "view=detail&id=invalid",
  ]) {
    assert.equal((await request(`/api/deployments?${query}`)).status, 400)
  }
  assert.equal(
    (
      await request(
        `/api/deployments?view=source&id=${deployed.id}&kind=source&path=tools/records.ts`
      )
    ).status,
    404
  )
  await client.connect(
    new StreamableHTTPClientTransport(new URL(origin + deployed.mcpPath), {
      requestInit: { headers: { Authorization: headers.Authorization } },
    })
  )
  const tools = await client.listTools()
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), [
    "brain_search",
    "records",
  ])
  const call = async (mode: string) =>
    client.callTool({ name: "records", arguments: { mode } })
  const result = (response: Awaited<ReturnType<typeof call>>) =>
    (response.structuredContent as { result: unknown }).result
  assert.deepEqual(result(await call("write")), {
    shell: "sandbox-ok",
    secret: null,
  })
  assert.deepEqual(result(await call("read")), {
    record: { value: { name: "Bicycle", status: "active" }, revision: 1 },
    file: "hello",
  })
  assert.equal((await call("conflict")).isError, true)
  const recordedCalls = await db.query(
    `SELECT id,status,input_json::jsonb AS input_json,output_json::jsonb AS output_json,attributes_json,duration_ms
    FROM traces WHERE project_id=$1 AND operation='mcp.tools.call' ORDER BY started_at_ms`,
    [project]
  )
  const written = recordedCalls.rows.find(
    (row) => row.input_json?.mode === "write"
  )
  assert(written, "MCP tool execution was not persisted as a trace")
  assert.equal(written.status, "completed")
  assert.equal(written.output_json.structuredContent.result.shell, "sandbox-ok")
  assert.equal(written.attributes_json["mcp.deployment.id"], deployed.id)
  assert.equal(
    written.attributes_json["mcp.deployment.environment"],
    "production"
  )
  assert.ok(written.duration_ms >= 0)
  assert.equal(
    recordedCalls.rows.find((row) => row.input_json?.mode === "conflict")
      ?.status,
    "errored"
  )
  assert.equal(
    (
      await db.query(
        "SELECT kind FROM spans WHERE project_id=$1 AND trace_id=$2",
        [project, written.id]
      )
    ).rows[0].kind,
    "tool"
  )
  const protocolTraces = await db.query(
    "SELECT DISTINCT operation FROM traces WHERE project_id=$1",
    [project]
  )
  assert(protocolTraces.rows.some((row) => row.operation === "mcp.initialize"))
  assert(protocolTraces.rows.some((row) => row.operation === "mcp.tools.list"))
  assert.equal((await call("escape")).isError, true)
  assert.equal(
    (await client.callTool({ name: "records", arguments: { mode: 123 } }))
      .isError,
    true
  )
  const rejected = await request(deployed.mcpPath, {
    jsonrpc: "2.0",
    id: "bounded-log",
    method: "tools/call",
    params: {
      name: "records",
      arguments: {
        mode: 123,
        password: "must-not-be-logged",
        note: `${key.key} ${"x".repeat(70 * 1024)}`,
      },
    },
  })
  const rejectedTrace = await db.query(
    "SELECT input_json,status FROM traces WHERE project_id=$1 AND id=$2",
    [project, rejected.headers.get("x-datool-trace-id")]
  )
  assert.equal(rejectedTrace.rows[0].status, "errored")
  const loggedInput = rejectedTrace.rows[0].input_json
  assert.doesNotMatch(loggedInput, /must-not-be-logged/)
  assert.equal(loggedInput.includes(key.key), false)
  assert.equal(JSON.parse(loggedInput).truncated, true)
  assert.ok(loggedInput.length < 67 * 1024)
  assert.equal(
    (result(await call("list")) as { items: unknown[] }).items.length,
    1
  )
  const brain = await client.callTool({
    name: "brain_search",
    arguments: { query: "returns" },
  })
  assert.match(JSON.stringify(brain), /thirty days/)
  const resources = await client.listResources()
  assert.equal(resources.resources.length, 3)
  assert.match(
    JSON.stringify(
      await client.readResource({ uri: resources.resources[0].uri })
    ),
    /bicycles/
  )
  assert.equal(
    (
      await request(
        "/api/project-mcp",
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { Authorization: `Bearer ${readKey.key}` }
      )
    ).status,
    403
  )
  const context = {
    database: createTracerDatabase(undefined, { projectId: project }),
    projectId: project,
    organizationId: organization,
  }
  const agent = (
    await db.query(
      "SELECT agent_id FROM project_deployed_agents WHERE project_id=$1",
      [project]
    )
  ).rows[0].agent_id
  const applied = await getRuntimeAppliedDefinitions(context, agent)
  assert.equal(applied.actions.length, 2)
  assert.equal(applied.procedures.length, 1)
  const unchanged = JSON.parse((await cli([directory])).stdout)
  assert.equal(unchanged.id, deployed.id)
  assert.equal(unchanged.unchanged, true)
  await writeFile(
    join(directory, "sources/fetch_sources.ts"),
    "export default async ctx => { await ctx.db.set('projects','bad',{}); return [] }"
  )
  await assert.rejects(cli([directory]), /HTTP 500|HTTP 400/)
  assert.equal(
    (await (await request("/api/deployments")).json()).data.id,
    deployed.id
  )
  assert.equal(
    (
      await db.query(
        "SELECT key FROM project_documents WHERE project_id=$1 AND key='bad'",
        [project]
      )
    ).rowCount,
    0
  )
  await writeFile(
    join(directory, "sources/fetch_sources.ts"),
    "export default async () => []"
  )
  await writeFile(toolFile, source.replace("return 'v1'", "return 'v2'"))
  await writeFile(
    join(directory, "sources/company.md"),
    "Our company now makes electric bicycles."
  )
  const updated = JSON.parse((await cli([directory])).stdout)
  assert.notEqual(updated.id, deployed.id)
  assert.equal(result(await call("version")), "v2")
  // Microseconds must survive the cursor or adjacent versions disappear between pages.
  await db.query("UPDATE project_deployments SET created_at=$2 WHERE id=$1", [
    deployed.id,
    "2026-11-12T01:00:00.000001Z",
  ])
  await db.query("UPDATE project_deployments SET created_at=$2 WHERE id=$1", [
    updated.id,
    "2026-11-12T01:00:00.000002Z",
  ])
  const latest = await readView({ view: "history", limit: "1" })
  assert.deepEqual(
    latest.items.map((item: { id: string }) => item.id),
    [updated.id]
  )
  assert.equal(latest.activeId, updated.id)
  const older = await readView({
    view: "history",
    limit: "1",
    cursor: latest.nextCursor,
  })
  assert.deepEqual(
    older.items.map((item: { id: string }) => item.id),
    [deployed.id]
  )
  assert.equal(older.nextCursor, null)
  assert.equal(
    (await readView({ view: "detail", id: deployed.id })).active,
    false
  )
  assert.equal(
    (
      await readView({
        view: "source",
        id: deployed.id,
        kind: "source",
        path: "sources/company.md",
      })
    ).text,
    firstSource.text
  )
  assert.equal(
    (
      await readView({
        view: "source",
        id: updated.id,
        kind: "source",
        path: "sources/company.md",
      })
    ).text,
    "Our company now makes electric bicycles."
  )

  assert.equal(
    await invokeDeploymentTool(context, deployed.id, "records", {
      mode: "version",
    }),
    "v1"
  )
  assert.deepEqual(result(await call("read")), {
    record: { value: { name: "Bicycle", status: "active" }, revision: 1 },
    file: "hello",
  })
  const stale = await request("/api/deployments", {
    bundle: await packDeployment(directory),
    expectedDeploymentId: deployed.id,
  })
  assert.equal(stale.status, 409)
  // Even an unchanged bundle must check the publication boundary after preparing.
  const lockingClient = await db.connect()
  try {
    await lockingClient.query("BEGIN")
    await lockingClient.query("SELECT id FROM project WHERE id=$1 FOR UPDATE", [
      project,
    ])
    const pending = deployProject(context, {
      bundle: await packDeployment(directory),
      expectedDeploymentId: updated.id,
    }).then(
      () => null,
      (error: unknown) => error
    )
    let waiting = false
    const deadline = Date.now() + 15_000
    while (!waiting && Date.now() < deadline) {
      const activity = await db.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM project WHERE%FOR UPDATE'"
      )
      waiting = activity.rowCount! > 0
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(
      waiting,
      true,
      "Unchanged deployment must acquire the publication lock"
    )
    await lockingClient.query(
      "UPDATE project_deployment_state SET active_id=$2 WHERE project_id=$1",
      [project, deployed.id]
    )
    await lockingClient.query("COMMIT")
    assert.match(String(await pending), /while this one was preparing/)
  } finally {
    await lockingClient.query("ROLLBACK")
    lockingClient.release()
    await db.query(
      "UPDATE project_deployment_state SET active_id=$2 WHERE project_id=$1",
      [project, updated.id]
    )
  }
  await rm(join(directory, "agents/foo/instructions.md"))
  await cli([directory])
  assert.equal(
    (await db.query("SELECT status FROM build_agents WHERE id=$1", [agent]))
      .rows[0].status,
    "archived"
  )
  await writeFile(
    join(directory, "agents/foo/instructions.md"),
    "Use the company brain and deployed tools."
  )
  await cli([directory])
  const restoredAgent = await db.query(
    "SELECT a.id,a.status FROM project_deployed_agents d JOIN build_agents a ON a.id=d.agent_id WHERE d.project_id=$1 AND d.slug='foo'",
    [project]
  )
  assert.deepEqual(restoredAgent.rows[0], { id: agent, status: "active" })
  // Preview publication, agents and durable capabilities cannot alter Production.
  const productionId = (await (await request("/api/deployments")).json()).data
    .id
  await writeFile(
    toolFile,
    source
      .replace("Bicycle", "Preview bicycle")
      .replace("return 'v1'", "return 'preview'")
  )
  await writeFile(
    join(directory, "sources/company.md"),
    "Preview company makes scooters."
  )
  const previewDeployment = JSON.parse(
    (await cli([directory, "--environment", "preview"])).stdout
  )
  assert.equal(previewDeployment.environment, "preview")
  assert.match(previewDeployment.mcpPath, /^\/api\/project-mcp\/[a-f0-9]{32}$/)
  assert.equal(previewDeployment.dirty, true)
  assert.equal(
    (await (await request("/api/deployments")).json()).data.id,
    productionId
  )
  assert.equal(
    JSON.parse((await cli(["status", "--environment", "preview"])).stdout).id,
    previewDeployment.id
  )
  const previewClient = new Client({ name: "preview-test", version: "1" })
  try {
    await previewClient.connect(
      new StreamableHTTPClientTransport(
        new URL(origin + previewDeployment.mcpPath),
        { requestInit: { headers: { Authorization: headers.Authorization } } }
      )
    )
    const previewCall = (mode: string) =>
      previewClient.callTool({ name: "records", arguments: { mode } })
    assert.deepEqual(result(await previewCall("read")), {
      record: null,
      file: null,
    })
    await previewCall("write")
    assert.equal(
      (
        result(await previewCall("read")) as {
          record: { value: { name: string } }
        }
      ).record.value.name,
      "Preview bicycle"
    )
    assert.equal(
      (result(await call("read")) as { record: { value: { name: string } } })
        .record.value.name,
      "Bicycle"
    )
    assert.equal(result(await call("version")), "v2")
    assert.equal(result(await previewCall("version")), "preview")
    const previewTrace = await db.query(
      "SELECT attributes_json FROM traces WHERE project_id=$1 AND input_json::jsonb->>'mode'='version' ORDER BY started_at_ms DESC LIMIT 1",
      [project]
    )
    assert.equal(
      previewTrace.rows[0].attributes_json["mcp.deployment.id"],
      previewDeployment.id
    )
    assert.equal(
      previewTrace.rows[0].attributes_json["mcp.deployment.environment"],
      "preview"
    )
    const brain = await previewClient.callTool({
      name: "brain_search",
      arguments: { query: "scooters" },
    })
    assert.match(JSON.stringify(brain), /Preview company makes scooters/)
    assert.doesNotMatch(
      JSON.stringify(
        await client.callTool({
          name: "brain_search",
          arguments: { query: "scooters" },
        })
      ),
      /Preview company makes scooters/
    )
  } finally {
    await previewClient.close()
  }
  const previewHistory = await readView({
    view: "history",
    filter: 'environment = "preview"',
  })
  assert.deepEqual(
    previewHistory.items.map((row: { id: string }) => row.id),
    [previewDeployment.id]
  )
  assert.equal(previewHistory.items[0].active, true)
  assert.equal(
    (
      await readView({
        view: "history",
        filter: 'branch = "feature/deployment-ui" environment = "production"',
      })
    ).items.some((row: { id: string }) => row.id === previewDeployment.id),
    false
  )
  assert.equal(
    (await readView({ view: "history", filter: '"bicycle"' })).items.some(
      (row: { id: string }) => row.id === previewDeployment.id
    ),
    true
  )
  for (const path of [
    "/api/deployments?environment=staging",
    "/api/deployments?view=history&filter=environment%20%3D%20%22staging%22",
  ])
    assert.equal((await request(path)).status, 400)
  const previewAgent = (
    await db.query(
      "SELECT agent_id FROM project_deployed_agents WHERE project_id=$1 AND environment='preview'",
      [project]
    )
  ).rows[0].agent_id
  assert.notEqual(previewAgent, agent)
  await rm(join(directory, "agents/foo/instructions.md"))
  await writeFile(
    toolFile,
    source.replace("return 'v1'", "return 'preview-v2'")
  )
  await cli([directory, "--environment", "preview"])
  const pinned = new Client({ name: "pinned-preview", version: "1" })
  try {
    await pinned.connect(
      new StreamableHTTPClientTransport(
        new URL(origin + previewDeployment.mcpPath),
        {
          requestInit: { headers: { Authorization: headers.Authorization } },
        }
      )
    )
    assert.equal(
      result(
        await pinned.callTool({
          name: "records",
          arguments: { mode: "version" },
        })
      ),
      "preview"
    )
    assert.match(JSON.stringify(await pinned.listResources()), /\/preview\//)
  } finally {
    await pinned.close()
  }
  assert.equal(
    (
      await db.query("SELECT status FROM build_agents WHERE id=$1", [
        previewAgent,
      ])
    ).rows[0].status,
    "archived"
  )
  assert.equal(
    (await db.query("SELECT status FROM build_agents WHERE id=$1", [agent]))
      .rows[0].status,
    "active"
  )
  await writeFile(
    join(directory, "agents/foo/instructions.md"),
    "Use the company brain and deployed tools."
  )
  await writeFile(toolFile, source.replace("return 'v1'", "return 'v2'"))
  const foreign = crypto.randomUUID()
  await db.query(
    "INSERT INTO project(id,organization_id,name,slug) VALUES($1,$2,'Second',$1)",
    [foreign, organization]
  )
  assert.equal(
    (
      await (
        await request("/api/deployments", undefined, {
          "x-project-id": foreign,
        })
      ).json()
    ).data,
    null
  )
  assert.deepEqual((await readView({ view: "history" }, foreign)).items, [])
  for (const query of [
    { view: "detail", id: deployed.id },
    {
      view: "source",
      id: deployed.id,
      kind: "source",
      path: "sources/company.md",
    },
  ]) {
    assert.equal(
      (
        await request(
          `/api/deployments?${new URLSearchParams(query as Record<string, string>)}`,
          undefined,
          {
            Authorization: `Bearer ${readKey.key}`,
            "x-project-id": foreign,
          }
        )
      ).status,
      404
    )
  }
  const second = JSON.parse((await cli([directory], foreign)).stdout)
  assert.notEqual(second.id, updated.id)
  const foreignContext = {
    database: createTracerDatabase(undefined, { projectId: foreign }),
    projectId: foreign,
    organizationId: organization,
  }
  assert.deepEqual(
    await invokeDeploymentTool(foreignContext, second.id, "records", {
      mode: "read",
    }),
    { record: null, file: null }
  )
  await assert.rejects(
    invokeDeploymentTool(foreignContext, deployed.id, "records", {
      mode: "read",
    }),
    /not found/
  )
  assert.equal(result(await call("delete")), true)
  assert.deepEqual(result(await call("read")), { record: null, file: null })
  // Cloud protocols own object routing/retention independently of the local disk case.
  for (const provider of ["s3", "gcs"] as const) {
    const storage = await storageFixture(provider)
    try {
      const connection = await saveStorageConnection(context, storage.input)
      const cloudProject = crypto.randomUUID()
      await db.query(
        "INSERT INTO project(id,organization_id,name,slug) VALUES($1,$2,'Cloud',$1)",
        [cloudProject, organization]
      )
      const cloud = {
        database: createTracerDatabase(undefined, { projectId: cloudProject }),
        projectId: cloudProject,
        organizationId: organization,
      }
      const bundle = await packDeployment(directory)
      bundle.config.storageConnectionId = connection.id
      bundle.agents = []
      const published = await deployProject(cloud, {
        bundle,
        expectedDeploymentId: null,
      })
      assert.ok("id" in published)
      await invokeDeploymentTool(cloud, published.id, "records", {
        mode: "write",
      })
      assert.equal(
        (
          (await invokeDeploymentTool(cloud, published.id, "records", {
            mode: "read",
          })) as { file: string }
        ).file,
        "hello"
      )
      await assert.rejects(
        removeStorageConnection(context, connection.id),
        /project bucket/
      )
      await assert.rejects(
        deployProject(cloud, {
          bundle: {
            ...bundle,
            config: { ...bundle.config, storageConnectionId: null },
          },
          expectedDeploymentId: published.id,
        }),
        /cannot change/
      )
      await invokeDeploymentTool(cloud, published.id, "records", {
        mode: "delete",
      })
    } finally {
      await storage.close()
    }
  }
  await verifyProjectPostgres({
    directory,
    origin,
    headers,
    db,
    organization,
    cli,
  })
  await symlink(
    join(directory, "sources/company.md"),
    join(directory, "tools/linked.ts")
  )
  await assert.rejects(packDeployment(directory), /Symlinks/)
  await rm(join(directory, "tools/linked.ts"))
  await writeFile(toolFile, "import data from '../.env'; export default data")
  await writeFile(join(directory, ".env"), "PRIVATE_KEY=never-bundle")
  await assert.rejects(packDeployment(directory), /hidden files/)
  assert.match(await readFile(join(directory, ".env"), "utf8"), /never-bundle/)
  console.log("PASS deployment publication, CLI, MCP, sandbox and isolation")
} finally {
  await client.close()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await db.end()
  await rm(directory, { recursive: true, force: true })
}
