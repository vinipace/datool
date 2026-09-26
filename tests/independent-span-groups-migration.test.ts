import { readFile, readdir } from "node:fs/promises"
import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { Pool } from "pg"
import { createIsolatedPostgres, seedTestWorkspace } from "./helpers/postgres"

test("migration preserves existing kinds, memberships and summaries while permitting independent kinds", async () => {
  const target = await createIsolatedPostgres()
  const pool = new Pool({ connectionString: target.databaseUrl })
  const client = await pool.connect()
  try {
    const next = "0009_independent_span_groups.sql"
    for (const file of (await readdir("migrations"))
      .filter((file) => file.endsWith(".sql") && file < next)
      .sort()) {
      await client.query(await readFile(`migrations/${file}`, "utf8"))
    }
    await seedTestWorkspace(target)
    await client.query(
      `insert into traces(project_id,id,name,operation,status,started_at) values($1,'trace','Original','test','running','2026-09-01T12:00:00Z')`,
      [target.projectId]
    )
    await client.query(
      `insert into spans(project_id,trace_id,id,name,kind,group_name,group_version,status,started_at)
      values($1,'trace','grouped','Recorded agent','agent','Research','v1','running','2026-09-01T12:00:00Z'),
        ($1,'trace','plain','Recorded tool','tool',null,null,'running','2026-09-01T12:00:00Z')`,
      [target.projectId]
    )
    const before = (
      await client.query(
        "select kind,group_name,row_count from invocation_hourly_stats"
      )
    ).rows
    await client.query("BEGIN")
    await client.query(await readFile(`migrations/${next}`, "utf8"))
    await client.query("COMMIT")
    expect(
      (await client.query("select id,kind,group_type from spans order by id"))
        .rows
    ).toEqual([
      { id: "grouped", kind: "agent", group_type: "agent" },
      { id: "plain", kind: "tool", group_type: null },
    ])
    expect(
      (
        await client.query(
          "select kind,group_name,row_count from invocation_hourly_stats"
        )
      ).rows
    ).toEqual(before)
    await client.query("update spans set kind='llm' where id='grouped'")
    expect(
      (
        await client.query(
          "select group_type,group_name from trace_group_memberships"
        )
      ).rows
    ).toEqual([{ group_type: "agent", group_name: "Research" }])
    expect(
      (
        await client.query(
          "select kind,group_name,row_count from invocation_hourly_stats"
        )
      ).rows
    ).toEqual(before)
    await assert.rejects(
      client.query("update spans set group_type='workflow' where id='grouped'"),
      /Group membership cannot change/
    )
    await client.query(
      `insert into spans(project_id,trace_id,id,name,kind,group_type,group_name,status,started_at)
      values($1,'trace','new','Function step','function','workflow','Research','completed','2026-09-01T12:00:00Z')`,
      [target.projectId]
    )
    expect(
      (
        await client.query(
          "select group_type from trace_group_memberships where source_id='new'"
        )
      ).rows[0].group_type
    ).toBe("workflow")
    await client.query("delete from spans where id='new'")
    expect(
      (
        await client.query(
          "select source_id from trace_group_memberships where source_id='new'"
        )
      ).rows
    ).toEqual([])
    expect(
      (
        await client.query(
          "select kind,group_name,row_count from invocation_hourly_stats"
        )
      ).rows
    ).toEqual(before)
  } finally {
    client.release()
    await pool.end()
    await target.close()
  }
})
