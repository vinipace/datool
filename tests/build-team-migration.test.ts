import { strict as assert } from "node:assert"
import { readFile, readdir } from "node:fs/promises"
import { test } from "bun:test"
import { Pool } from "pg"
import { createIsolatedPostgres, seedTestWorkspace } from "./helpers/postgres"

test("team migration preserves legacy groups, members and ticket assignments", async () => {
  const target = await createIsolatedPostgres()
  const pool = new Pool({ connectionString: target.databaseUrl })
  try {
    const migration = "0054_organization_teams.sql"
    for (const file of (await readdir("migrations"))
      .filter((file) => file.endsWith(".sql") && file < migration)
      .sort()) {
      await pool.query(await readFile(`migrations/${file}`, "utf8"))
    }
    await seedTestWorkspace(target)
    const otherProject = crypto.randomUUID()
    await pool.query(
      `insert into project(id,organization_id,name,slug) values ($1,$2,'Other project','other')`,
      [otherProject, target.organizationId]
    )
    await pool.query(
      `insert into build_teams(id,project_id,name) values ('team-one',$1,'Support'),('team-two',$2,'support')`,
      [target.projectId, otherProject]
    )
    await pool.query(
      `insert into build_team_members(project_id,team_id,user_id,availability,max_concurrent) values ($1,'team-one',$3,'online',7),($2,'team-two',$3,'away',12)`,
      [target.projectId, otherProject, target.ownerId]
    )
    await pool.query(
      `insert into build_inbox_tickets(id,project_id,conversation_id,channel,team_id,assignee_user_id) values ('ticket-one',$1,'legacy-conversation','web','team-one',$2)`,
      [target.projectId, target.ownerId]
    )
    await pool.query(
      `insert into build_routing_rules(id,project_id,name,team_id) values ('route-one',$1,'Support route','team-one')`,
      [target.projectId]
    )
    await pool.query(await readFile(`migrations/${migration}`, "utf8"))
    const groups = (
      await pool.query(
        "select id,organization_id,name from build_teams order by id"
      )
    ).rows
    assert.equal(groups.length, 2)
    assert(
      groups.every((team) => team.organization_id === target.organizationId)
    )
    assert.notEqual(groups[0].name.toLowerCase(), groups[1].name.toLowerCase())
    assert.deepEqual(
      (
        await pool.query(
          "select team_id,user_id,availability,max_concurrent from build_team_members order by team_id"
        )
      ).rows,
      [
        {
          team_id: "team-one",
          user_id: target.ownerId,
          availability: "online",
          max_concurrent: 7,
        },
        {
          team_id: "team-two",
          user_id: target.ownerId,
          availability: "away",
          max_concurrent: 12,
        },
      ]
    )
    assert.equal(
      (
        await pool.query(
          "select team_id from build_inbox_tickets where id='ticket-one'"
        )
      ).rows[0].team_id,
      "team-one"
    )
    await pool.query(
      "update build_inbox_tickets set team_id='team-two' where id='ticket-one'"
    )
    assert.equal(
      (
        await pool.query(
          "select team_id from build_routing_rules where id='route-one'"
        )
      ).rows[0].team_id,
      "team-one"
    )
    await pool.query("delete from project where id=$1", [otherProject])
    assert.equal(
      (await pool.query("select count(*)::int as count from build_teams"))
        .rows[0].count,
      2
    )
  } finally {
    await pool.end()
    await target.close()
  }
}, 60_000)
