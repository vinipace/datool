import assert from "node:assert/strict"
import { cp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises"
import { join } from "node:path"
import type { Pool } from "pg"
import { Client as PgClient } from "pg"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { decryptProviderKey } from "../../src/server/model-providers/secrets"

// Extends the real CLI/HTTP/MCP owner test with SQL migration and type contracts.
export async function verifyProjectPostgres(options: {
  directory: string
  origin: string
  headers: Record<string, string>
  db: Pool
  organization: string
  cli: (args: string[], projectId?: string) => Promise<{ stdout: string }>
}) {
  const { directory, origin, headers, db, organization, cli } = options
  const root = join(directory, "postgres")
  for (const path of ["tools", "sources", "node_modules/@datool/sdk"])
    await mkdir(join(root, path), { recursive: true })
  await cp(
    await realpath("node_modules/drizzle-orm"),
    join(root, "node_modules/drizzle-orm"),
    { recursive: true }
  )
  await cp("packages/sdk/dist", join(root, "node_modules/@datool/sdk/dist"), {
    recursive: true,
  })
  await cp(
    "packages/sdk/package.json",
    join(root, "node_modules/@datool/sdk/package.json")
  )
  const schema = `import {pgTable, text, integer, timestamp} from 'drizzle-orm/pg-core';
export const projects=pgTable('projects',{id:integer().generatedAlwaysAsIdentity().primaryKey(),name:text().notNull(),createdAt:timestamp('created_at').notNull().defaultNow()});`
  await writeFile(join(root, "schema.ts"), schema)
  const tool = `import {defineTool} from '../datool.generated';import {projects} from '../schema';import {sql} from 'drizzle-orm';
export default defineTool({description:'SQL project records',inputSchema:{type:'object',properties:{mode:{type:'string'}},required:['mode']},async execute(input:{mode:string},ctx){
if(input.mode==='insert') return ctx.sql.insert(projects).values({name:'Orion'}).returning();
if(input.mode==='ddl') return ctx.sql.execute(sql.raw('DROP TABLE projects'));
if(input.mode==='host') return ctx.sql.execute(sql.raw("SELECT pg_read_file('/etc/passwd')"));
if(input.mode==='app') return ctx.sql.execute(sql.raw('SELECT * FROM project_postgres'));
if(input.mode==='multi') return ctx.sql.execute(sql.raw("SELECT 1; DROP TABLE projects"));
if(input.mode==='history') return ctx.sql.execute(sql.raw('SELECT * FROM datool_meta.migrations'));
if(input.mode==='value') return ctx.sql.execute(sql.raw("SELECT repeat('x',4000000)"));
if(input.mode==='large') return ctx.sql.execute(sql.raw('SELECT generate_series(1,1000000)'));
return ctx.sql.select().from(projects).limit(5);
}});`
  await writeFile(join(root, "tools/records.ts"), tool)
  const ids: string[] = []
  const clients: Client[] = []
  try {
    for (let index = 0; index < 2; index++) {
      const id = crypto.randomUUID()
      ids.push(id)
      await db.query(
        "INSERT INTO project(id,organization_id,name,slug) VALUES($1,$2,'Postgres test',$1)",
        [id, organization]
      )
      const plan = JSON.parse((await cli([root, "--plan"], id)).stdout)
      assert.ok(
        plan.database.statements.some((s: string) =>
          s.includes('CREATE TABLE "projects"')
        )
      )
      assert.equal(
        (
          await db.query("SELECT * FROM project_postgres WHERE project_id=$1", [
            id,
          ])
        ).rowCount,
        0,
        "Planning must not provision a database"
      )
      const deployed = JSON.parse((await cli([root], id)).stdout)
      assert.ok(deployed.database.statements.length)
      assert.match(
        await readFile(
          join(root, `migrations/${deployed.database.hash}.sql`),
          "utf8"
        ),
        /CREATE TABLE/
      )
      const mcp = new Client({ name: "postgres-test", version: "1" })
      clients.push(mcp)
      await mcp.connect(
        new StreamableHTTPClientTransport(new URL(origin + deployed.mcpPath), {
          requestInit: { headers: { ...headers, "x-project-id": id } },
        })
      )
    }
    const call = (index: number, mode: string) =>
      clients[index].callTool({ name: "records", arguments: { mode } })
    const result = (response: Awaited<ReturnType<typeof call>>) => {
      assert.notEqual(response.isError, true, JSON.stringify(response))
      return (
        response.structuredContent as { result: Record<string, unknown>[] }
      ).result
    }
    const inserted = result(await call(0, "insert"))
    assert.equal(inserted[0].name, "Orion")
    assert.equal(inserted[0].id, 1)
    assert.match(String(inserted[0].createdAt), /^\d{4}-\d\d-\d\dT/)
    assert.equal(result(await call(0, "read")).length, 1)
    assert.equal(
      result(await call(1, "read")).length,
      0,
      "Projects must have distinct physical databases"
    )
    const preview = JSON.parse(
      (await cli([root, "--environment", "preview"], ids[0])).stdout
    )
    const previewMcp = new Client({ name: "preview-sql-test", version: "1" })
    clients.push(previewMcp)
    await previewMcp.connect(
      new StreamableHTTPClientTransport(new URL(origin + preview.mcpPath), {
        requestInit: { headers: { ...headers, "x-project-id": ids[0] } },
      })
    )
    assert.equal(
      result(await call(2, "read")).length,
      0,
      "Preview must have a separate physical database"
    )
    assert.equal(result(await call(2, "insert"))[0].id, 1)
    assert.equal(
      result(await call(0, "read")).length,
      1,
      "Preview inserts must not reach Production"
    )
    for (const mode of [
      "ddl",
      "host",
      "app",
      "multi",
      "history",
      "large",
      "value",
    ])
      assert.equal((await call(0, mode)).isError, true, mode)
    // Inferred schema types must reject the invalid column before any API call.
    await writeFile(
      join(root, "tools/records.ts"),
      tool.replace("{name:'Orion'}", "{missingColumn:'Orion'}")
    )
    await assert.rejects(cli([root, "--dry-run"], ids[0]), /missingColumn/)
    await writeFile(join(root, "tools/records.ts"), tool)
    const unchanged = JSON.parse((await cli([root], ids[0])).stdout)
    assert.equal(unchanged.unchanged, true)
    assert.deepEqual(unchanged.database.statements, [])
    const added = schema.replace(
      "name:text().notNull(),",
      "name:text().notNull(),status:text().default('active'),"
    )
    await writeFile(join(root, "schema.ts"), added)
    await writeFile(
      join(root, "sources/projects.js"),
      `import {defineSource} from '../datool.generated';import {projects} from '../schema';export default defineSource(async ctx=>{const rows=await ctx.sql.select().from(projects).limit(10);return [{path:'projects.md',title:'Projects',text:rows.map(r=>r.name+' '+r.status).join(', ')||'No projects'}]});`
    )
    const upgraded = JSON.parse((await cli([root], ids[0])).stdout)
    assert.ok(
      upgraded.database.statements.some((s: string) => s.includes("ADD COLUMN"))
    )
    const records = result(await call(0, "read"))
    assert.equal(records[0].name, "Orion")
    assert.equal(records[0].status, "active")
    const brain = await clients[0].callTool({
      name: "brain_search",
      arguments: { query: "Orion" },
    })
    assert.equal(brain.isError, undefined)
    assert.match(JSON.stringify(brain), /active/)
    // New NOT NULL column without a default fails and rolls back all DDL/history.
    await writeFile(
      join(root, "schema.ts"),
      added.replace(
        "status:text().default('active'),",
        "status:text().default('active'),required:text().notNull(),"
      )
    )
    await writeFile(
      join(root, "tools/records.ts"),
      tool.replace("{name:'Orion'}", "{name:'Orion',required:'new row'}")
    )
    await assert.rejects(cli([root], ids[0]), /23502/)
    await writeFile(join(root, "tools/records.ts"), tool)
    await writeFile(
      join(root, "schema.ts"),
      added.replace(
        "id:integer().generatedAlwaysAsIdentity().primaryKey(),",
        ""
      )
    )
    await assert.rejects(cli([root], ids[0]), /cannot remove or change/)
    await writeFile(
      join(root, "schema.ts"),
      added.replace(
        "status:text().default('active'),",
        "status:text().default('active'),note:text(),"
      )
    )
    await writeFile(
      join(root, "sources/projects.js"),
      `import {defineSource} from '../datool.generated';import {projects} from '../schema';export default defineSource(async ctx=>{await ctx.sql.delete(projects);return []});`
    )
    await assert.rejects(cli([root], ids[0]), /deployed module failed/)
    assert.equal(result(await call(0, "read")).length, 1)
    const status = await fetch(origin + "/api/deployments", {
      headers: { ...headers, "x-project-id": ids[0] },
    }).then((response) => response.json())
    assert.equal(
      status.data.id,
      upgraded.id,
      "Failed collection must preserve the active deployment"
    )
    await rm(join(root, "sources/projects.js"))
    const retry = JSON.parse((await cli([root], ids[0])).stdout)
    assert.deepEqual(retry.database.statements, [])
    assert.match(
      await readFile(
        join(root, `migrations/${retry.database.migration.hash}.sql`),
        "utf8"
      ),
      /ADD COLUMN "note"/
    )
    assert.equal(result(await call(0, "read"))[0].note, null)
  } finally {
    for (const mcp of clients) await mcp.close()
    const admin = new PgClient({
      connectionString: process.env.DATOOL_PROJECT_DATABASE_ADMIN_URL,
    })
    await admin.connect()
    try {
      for (const id of ids) {
        const stored = await db.query(
          "SELECT encrypted_credentials,environment FROM project_postgres WHERE project_id=$1",
          [id]
        )
        for (const row of stored.rows) {
          const access = JSON.parse(
            decryptProviderKey(
              row.encrypted_credentials,
              row.environment === "preview" ? `${id}:preview` : id,
              "project-postgres"
            )
          ) as Record<string, string>
          const url = new URL(access.owner)
          const q = (value: string) => '"' + value.replaceAll('"', '""') + '"'
          await admin.query(
            `DROP DATABASE ${q(url.pathname.slice(1))} WITH (FORCE)`
          )
          for (const value of Object.values(access))
            await admin.query(`DROP ROLE ${q(new URL(value).username)}`)
        }
      }
    } finally {
      await admin.end()
    }
  }
}
