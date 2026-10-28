import { expect, test } from "bun:test"
import { strict as assert } from "node:assert"
import { sql } from "drizzle-orm"
import { createAgent } from "@/src/server/build/agents"
import { buildOperations } from "@/src/server/build/bootstrap"
import { createConversationService } from "@/src/server/build/conversations"
import {
  addTicketNote,
  assignTicket,
  createTicket,
  listTickets,
} from "@/src/server/build/operations/inbox"
import { collectData, upsertLead } from "@/src/server/build/operations/contacts"
import { getTracerProjectId } from "@/src/server/tracer/db"
import {
  closeTracerFixture,
  createTracerFixture,
} from "./helpers/tracer-fixture"

test("agent activity and inbox queues stay scoped before pagination", async () => {
  const database = await createTracerFixture()
  const projectId = getTracerProjectId(database)
  try {
    const members = await database.execute<{ id: string; email: string }>(sql`
      select u.id,u.email from "user" u join member m on m."userId"=u.id
      join project p on p.organization_id=m."organizationId" where p.id=${projectId}
    `)
    const member = members.rows[0]!
    const context = { database, projectId, actorId: member.id }
    await createAgent(context, {
      id: "support",
      name: "Support",
      slug: "support",
      configuration: { model: "openai/gpt-4.1-mini" },
    })
    const tickets = []
    for (let index = 0; index < 4; index++) {
      const conversation = await createConversationService(context).getOrCreate(
        {
          agentId: "support",
          channel: "web",
          externalConversationId: `request-${index}`,
          metadata: {},
        }
      )
      tickets.push(
        await createTicket(context, {
          conversationId: conversation.id,
          channel: "web",
          subject: `Request ${index}`,
          status: index === 3 ? "solved" : "open",
        })
      )
    }
    await assignTicket(context, {
      ticketId: tickets[0]!.id,
      assigneeUserId: member.id,
      expectedVersion: tickets[0]!.version,
    })
    await addTicketNote(context, {
      ticketId: tickets[1]!.id,
      body: `Please help @${member.email.toUpperCase()}.`,
    })
    await addTicketNote(context, {
      ticketId: tickets[2]!.id,
      body: `Other addresses: @${member.email}.invalid and prefix@${member.email}`,
    })
    await addTicketNote(context, {
      ticketId: tickets[3]!.id,
      body: `Resolved with @${member.email}`,
    })

    // Exercise the same validated operation contract used by the browser.
    const operation = buildOperations.find(
      (item) => item.name === "build_list_tickets"
    )!
    const input = operation.schema.parse({ queue: "mine", limit: 1 })
    const mine = (await operation.execute(context, input)) as Awaited<
      ReturnType<typeof listTickets>
    >
    expect(mine.items.map((item) => item.id)).toEqual([tickets[0]!.id])
    expect(mine.nextCursor).toBeNull()
    expect(
      (await listTickets(context, { queue: "unassigned" })).items
        .map((item) => item.id)
        .sort()
    ).toEqual(
      tickets
        .slice(1)
        .map((item) => item.id)
        .sort()
    )
    expect(
      (
        await listTickets(context, {
          queue: "mentions",
          status: "open",
          limit: 1,
        })
      ).items.map((item) => item.id)
    ).toEqual([tickets[1]!.id])
    expect(
      (await listTickets(context, { status: "solved" })).items.map(
        (item) => item.id
      )
    ).toEqual([tickets[3]!.id])
    expect(
      (await listTickets({ ...context, actorId: undefined }, { queue: "mine" }))
        .items
    ).toEqual([])
    expect(
      (
        await listTickets(
          { ...context, actorId: undefined },
          { queue: "mentions" }
        )
      ).items
    ).toEqual([])
    expect(
      (await listTickets(context, { queue: "mine", search: "Request 3" })).items
    ).toEqual([])

    const foreignId = crypto.randomUUID()
    await database.execute(sql`insert into project(id,organization_id,name,slug)
      select ${foreignId},organization_id,'Other',${foreignId} from project where id=${projectId}`)
    const foreign = { ...context, projectId: foreignId }
    await createAgent(foreign, {
      id: "foreign-support",
      name: "Support",
      slug: "support",
      configuration: { model: "openai/gpt-4.1-mini" },
    })
    await database.execute(sql`insert into build_conversations(id,project_id,agent_id,channel,external_conversation_id)
      values ('foreign-conversation',${foreignId},'foreign-support','web','foreign')`)
    const foreignTicket = await createTicket(foreign, {
      conversationId: "foreign-conversation",
      channel: "web",
    })
    await addTicketNote(foreign, {
      ticketId: foreignTicket.id,
      body: `@${member.email}`,
    })
    expect(
      (await listTickets(context, { queue: "mentions" })).items
        .map((item) => item.id)
        .sort()
    ).toEqual([tickets[1]!.id, tickets[3]!.id].sort())

    // Identical timestamps require the ticket ID as a stable cursor tie-breaker.
    await database.execute(
      sql`update build_inbox_tickets set updated_at='2026-10-20 10:00:00.123456+00' where project_id=${projectId}`
    )
    const first = await listTickets(context, { order: "recent", limit: 2 })
    const second = await listTickets(context, {
      order: "recent",
      limit: 2,
      cursor: first.nextCursor!,
    })
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual(
      tickets
        .map((item) => item.id)
        .sort()
        .reverse()
    )
    expect(second.nextCursor).toBeNull()
    await assert.rejects(
      () => listTickets(context, { order: "recent", cursor: "invalid" }),
      { code: "VALIDATION_ERROR" }
    )
    await createAgent(context, {
      id: "other-agent",
      name: "Other agent",
      slug: "other-agent",
      configuration: { model: "openai/gpt-4.1-mini" },
    })
    const otherConversation = await createConversationService(
      context
    ).getOrCreate({
      agentId: "other-agent",
      channel: "web",
      externalConversationId: "other-agent",
      metadata: {},
    })
    const otherTicket = await createTicket(context, {
      conversationId: otherConversation.id,
      channel: "web",
    })
    await assignTicket(context, {
      ticketId: otherTicket.id,
      assigneeUserId: member.id,
      expectedVersion: otherTicket.version,
    })
    await addTicketNote(context, {
      ticketId: otherTicket.id,
      body: `@${member.email}`,
    })
    const execute = async (name: string, input: Record<string, unknown>) => {
      const operation = buildOperations.find((item) => item.name === name)!
      return (await operation.execute(
        context,
        operation.schema.parse(input)
      )) as {
        items: { id: string; conversationId: string }[]
        nextCursor: string | null
      }
    }
    for (const order of ["id", "recent"]) {
      const ids: string[] = []
      let cursor: string | undefined
      do {
        const page = await execute("build_list_tickets", {
          agentId: "support",
          order,
          limit: 1,
          cursor,
        })
        ids.push(...page.items.map((item) => item.id))
        cursor = page.nextCursor ?? undefined
      } while (cursor && ids.length < 10)
      expect(ids.sort()).toEqual(tickets.map((item) => item.id).sort())
    }
    expect(
      (
        await execute("build_list_tickets", {
          agentId: "support",
          queue: "mine",
        })
      ).items.map((item) => item.id)
    ).toEqual([tickets[0]!.id])
    expect(
      (
        await execute("build_list_tickets", {
          agentId: "support",
          queue: "mentions",
          status: "open",
        })
      ).items.map((item) => item.id)
    ).toEqual([tickets[1]!.id])
    expect(
      (await execute("build_list_tickets", { agentId: "foreign-support" }))
        .items
    ).toEqual([])

    // Activity belongs to the agent that handled the conversation; records
    // from other agents and projects must not appear in its pages.
    for (const [ctx, conversationId] of [
      [context, tickets[0]!.conversationId],
      [context, tickets[1]!.conversationId],
      [context, otherConversation.id],
      [foreign, "foreign-conversation"],
    ] as const) {
      await upsertLead(ctx, {
        conversationId,
        data: { name: "Shared customer" },
      })
      await collectData(ctx, {
        conversationId,
        fieldKey: "company",
        value: "Example",
        source: "manual",
      })
    }
    for (const name of ["build_list_leads", "build_list_collected_data"]) {
      const first = await execute(name, { agentId: "support", limit: 1 })
      expect(first.items).toHaveLength(1)
      expect(first.nextCursor).not.toBeNull()
      const second = await execute(name, {
        agentId: "support",
        limit: 1,
        cursor: first.nextCursor,
      })
      expect(second.items).toHaveLength(1)
      expect(second.nextCursor).toBeNull()
      expect(
        [...first.items, ...second.items]
          .map((item) => item.conversationId)
          .sort()
      ).toEqual([tickets[0]!.conversationId, tickets[1]!.conversationId].sort())
      expect(
        (await execute(name, { agentId: "foreign-support" })).items
      ).toEqual([])
      expect((await execute(name, { agentId: "missing-agent" })).items).toEqual(
        []
      )
    }
  } finally {
    await closeTracerFixture(database)
  }
})
