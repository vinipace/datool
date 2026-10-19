import { expect, test } from "bun:test"
import { strict as assert } from "node:assert"
import { sql } from "drizzle-orm"
import { createAgent } from "@/src/server/build/agents"
import {
  assignTicket,
  createTicket,
  takeoverConversation,
} from "@/src/server/build/operations/inbox"
import {
  createTeam,
  updateTeam,
  listTeams,
  listOrganizationMembers,
  setTeamMember,
  setAgentAvailability,
  createRoutingRule,
} from "@/src/server/build/operations/teams"
import {
  createTracerDatabase,
  closeTracerDatabase,
  getTracerProjectId,
} from "@/src/server/tracer/db"
import {
  createTracerFixture,
  closeTracerFixture,
} from "./helpers/tracer-fixture"

test("organization teams share members across projects and reject foreign assignment targets", async () => {
  const database = await createTracerFixture()
  const projectId = getTracerProjectId(database)
  const row = (
    await database.execute<{
      organization_id: string
      user_id: string
      schema: string
    }>(sql`
    select p.organization_id,m."userId" as user_id,current_schema() as schema
    from project p join member m on m."organizationId"=p.organization_id where p.id=${projectId}
  `)
  ).rows[0]!
  const first = { database, projectId, actorId: row.user_id }
  const otherProject = crypto.randomUUID()
  const foreignProject = crypto.randomUUID()
  const foreignOrg = crypto.randomUUID()
  const foreignUser = crypto.randomUUID()
  await database.execute(
    sql`insert into project(id,organization_id,name,slug) values (${otherProject},${row.organization_id},'Second project','second')`
  )
  await database.execute(
    sql`insert into organization(id,name,slug,"createdAt") values (${foreignOrg},'Other organization',${foreignOrg},now())`
  )
  await database.execute(
    sql`insert into project(id,organization_id,name,slug) values (${foreignProject},${foreignOrg},'Foreign project','foreign')`
  )
  await database.execute(
    sql`insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values (${foreignUser},'Foreign user',${foreignUser + "@example.test"},false,now(),now())`
  )
  await database.execute(
    sql`insert into member(id,"organizationId","userId",role,"createdAt") values (${crypto.randomUUID()},${foreignOrg},${foreignUser},'owner',now())`
  )
  const secondDb = createTracerDatabase(process.env.DATOOL_TEST_DATABASE_URL, {
    projectId: otherProject,
    schema: row.schema,
  })
  const foreignDb = createTracerDatabase(process.env.DATOOL_TEST_DATABASE_URL, {
    projectId: foreignProject,
    schema: row.schema,
  })
  const second = {
    database: secondDb,
    projectId: otherProject,
    actorId: row.user_id,
  }
  const foreign = {
    database: foreignDb,
    projectId: foreignProject,
    actorId: foreignUser,
  }
  try {
    const team = await createTeam(first, {
      name: "Support",
      memberIds: [row.user_id],
    })
    expect(team.organizationId).toBe(row.organization_id)
    expect((await listTeams(second))[0]).toMatchObject({
      id: team.id,
      memberCount: 1,
      memberIds: [row.user_id],
    })
    expect(await listTeams(foreign)).toEqual([])
    expect(
      (await listOrganizationMembers(second)).map((member) => member.id)
    ).toEqual([row.user_id])
    await assert.rejects(
      () => createTeam(second, { name: "support" }),
      /already exists/
    )
    await assert.rejects(
      () =>
        createTeam(first, { name: "Invalid group", memberIds: [foreignUser] }),
      /belong to this organization/
    )
    expect(await listTeams(first)).toHaveLength(1)
    await assert.rejects(
      () => updateTeam(foreign, team.id, { name: "Hijacked" }),
      /not found/
    )
    await assert.rejects(
      () => setTeamMember(first, { teamId: team.id, userId: foreignUser }),
      /not a member/
    )

    for (const context of [first, second, foreign]) {
      await createAgent(context, {
        id: "agent-" + context.projectId,
        name: "Agent",
        slug: "agent",
        configuration: { model: "openai/gpt-4.1-mini" },
      })
      await context.database.execute(
        sql`insert into build_conversations(id,project_id,agent_id,channel) values (${"conversation-" + context.projectId},${context.projectId},${"agent-" + context.projectId},'web')`
      )
    }
    await setTeamMember(first, {
      teamId: team.id,
      userId: row.user_id,
      availability: "online",
      maxConcurrent: 1,
    })
    await createRoutingRule(second, { name: "Shared support", teamId: team.id })
    const ticket1 = await createTicket(first, {
      conversationId: "conversation-" + projectId,
      channel: "web",
    })
    const assigned = await assignTicket(first, {
      ticketId: ticket1.id,
      teamId: team.id,
      assigneeUserId: row.user_id,
      expectedVersion: ticket1.version,
    })
    expect(assigned.assigneeName).toBe("Test owner")
    expect(assigned.teamName).toBe("Support")
    const ticket2 = await createTicket(second, {
      conversationId: "conversation-" + otherProject,
      channel: "web",
    })
    expect(ticket2.teamId).toBe(team.id)
    expect(ticket2.assigneeUserId).toBeNull() // Capacity includes work in the first project.
    await assignTicket(second, {
      ticketId: ticket2.id,
      teamId: team.id,
      assigneeUserId: row.user_id,
      expectedVersion: ticket2.version,
    })
    const foreignTicket = await createTicket(foreign, {
      conversationId: "conversation-" + foreignProject,
      channel: "web",
    })
    await assert.rejects(
      () =>
        assignTicket(foreign, {
          ticketId: foreignTicket.id,
          teamId: team.id,
          assigneeUserId: null,
          expectedVersion: foreignTicket.version,
        }),
      /not enabled/
    )
    await assert.rejects(
      () =>
        takeoverConversation(foreign, {
          conversationId: "conversation-" + foreignProject,
          teamId: team.id,
        }),
      /not enabled/
    )
    await assert.rejects(
      () =>
        createRoutingRule(foreign, { name: "Foreign team", teamId: team.id }),
      /not enabled/
    )
    await assert.rejects(
      () =>
        foreignDb.execute(
          sql`update build_inbox_tickets set team_id=${team.id} where id=${foreignTicket.id}`
        ),
      (error: unknown) =>
        error instanceof Error &&
        (error.cause as { code?: string })?.code === "23503"
    )
    await updateTeam(second, team.id, { memberIds: [] })
    expect((await listTeams(first))[0]?.memberCount).toBe(0)
    await assert.rejects(
      () =>
        assignTicket(first, {
          ticketId: ticket1.id,
          teamId: team.id,
          assigneeUserId: row.user_id,
          expectedVersion: assigned.version,
        }),
      /not a member of team/
    )
    await updateTeam(first, team.id, { memberIds: [row.user_id] })
    expect(
      (
        await setAgentAvailability(second, {
          userId: row.user_id,
          availability: "away",
        })
      ).updatedMemberships
    ).toBe(1)
    await database.execute(sql`delete from project where id=${projectId}`)
    expect((await listTeams(second))[0]?.id).toBe(team.id) // Teams outlive their original project.
  } finally {
    await closeTracerDatabase(secondDb)
    await closeTracerDatabase(foreignDb)
    await closeTracerFixture(database)
  }
}, 60_000)
