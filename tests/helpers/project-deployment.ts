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
  assert.equal(deployed.unchanged, false)
  await client.connect(
    new StreamableHTTPClientTransport(new URL(origin + deployed.mcpPath), {
      requestInit: { headers },
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
  assert.equal((await call("escape")).isError, true)
  assert.equal(
    (await client.callTool({ name: "records", arguments: { mode: 123 } }))
      .isError,
    true
  )
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
  const updated = JSON.parse((await cli([directory])).stdout)
  assert.notEqual(updated.id, deployed.id)
  assert.equal(result(await call("version")), "v2")
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
