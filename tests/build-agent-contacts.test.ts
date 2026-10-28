import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"

import { createAgent } from "@/src/server/build/agents"
import { buildOperations } from "@/src/server/build/bootstrap"
import { createConversationService } from "@/src/server/build/conversations"
import {
  collectData,
  createContact,
  type exportContacts,
  type listContacts,
  upsertLead,
} from "@/src/server/build/operations/contacts"
import { createTicket } from "@/src/server/build/operations/inbox"
import { getTracerProjectId } from "@/src/server/tracer/db"
import {
  closeTracerFixture,
  createTracerFixture,
} from "./helpers/tracer-fixture"

test("agent contacts and exports filter relationships before pagination without duplicates or project leaks", async () => {
  const database = await createTracerFixture()
  const projectId = getTracerProjectId(database)
  const context = { database, projectId }
  try {
    for (const id of ["support", "sales"]) {
      await createAgent(context, { id, name: id, slug: id })
    }
    const conversations = createConversationService(context)
    const linked = []
    for (const relation of ["metadata", "ticket", "lead", "collected"]) {
      const contact = await createContact(context, {
        displayName: `Linked ${relation}`,
        status: relation === "lead" ? "blocked" : "active",
      })
      linked.push(contact)
      const conversation = await conversations.getOrCreate({
        agentId: "support",
        channel: "web",
        metadata: relation === "metadata" ? { contactId: contact.id } : {},
      })
      if (relation === "ticket") {
        await createTicket(context, {
          conversationId: conversation.id,
          contactId: contact.id,
          channel: "web",
        })
      } else if (relation === "lead") {
        await upsertLead(context, {
          conversationId: conversation.id,
          contactId: contact.id,
        })
      } else if (relation === "collected") {
        await collectData(context, {
          conversationId: conversation.id,
          contactId: contact.id,
          fieldKey: "plan",
          value: "pro",
        })
      }
    }
    // Repeat one contact across conversations and agents; list it once per agent.
    for (const agentId of ["support", "sales"]) {
      await conversations.getOrCreate({
        agentId,
        channel: "web",
        metadata: { contactId: linked[0]!.id },
      })
    }
    const salesOnly = await createContact(context, {
      displayName: "Sales only",
    })
    await conversations.getOrCreate({
      agentId: "sales",
      channel: "web",
      metadata: { contactId: salesOnly.id },
    })
    await createContact(context, { displayName: "Imported without an agent" })
    const foreignOnly = await createContact(context, {
      displayName: "Foreign association only",
    })
    const foreignProjectId = crypto.randomUUID()
    await database.execute(sql`
      insert into project(id,organization_id,name,slug)
      select ${foreignProjectId},organization_id,'Other',${foreignProjectId}
      from project where id=${projectId}
    `)
    const foreign = { database, projectId: foreignProjectId }
    await createAgent(foreign, {
      id: "foreign-agent",
      name: "Foreign",
      slug: "foreign",
    })
    await database.execute(sql`
      insert into build_conversations(id,project_id,agent_id,channel,metadata_json)
      values ('foreign-conversation',${foreignProjectId},'foreign-agent','web',
        ${JSON.stringify({ contactId: foreignOnly.id })}::jsonb)
    `)

    const listOperation = buildOperations.find(
      (item) => item.name === "build_list_contacts"
    )!
    const list = async (input: Record<string, unknown>) =>
      (await listOperation.execute(
        context,
        listOperation.schema.parse(input)
      )) as Awaited<ReturnType<typeof listContacts>>
    const expectedIds = linked.map((contact) => contact.id).sort()
    const receivedIds: string[] = []
    let cursor: string | undefined
    do {
      const page = await list({ agentId: "support", limit: 1, cursor })
      expect(page.items).toHaveLength(1)
      receivedIds.push(...page.items.map((contact) => contact.id))
      cursor = page.nextCursor ?? undefined
    } while (cursor && receivedIds.length < 10)
    expect(cursor).toBeUndefined()
    expect(receivedIds).toEqual(expectedIds)
    expect(
      (await list({ agentId: "sales" })).items
        .map((contact) => contact.id)
        .sort()
    ).toEqual([linked[0]!.id, salesOnly.id].sort())
    expect((await list({ agentId: "foreign-agent" })).items).toEqual([])
    expect((await list({ agentId: "missing-agent" })).items).toEqual([])
    expect((await list({})).items).toHaveLength(7)
    expect(
      (await list({ agentId: "support", search: "Linked", status: "blocked" }))
        .items.map((contact) => contact.id)
    ).toEqual([linked[2]!.id])

    const exportOperation = buildOperations.find(
      (item) => item.name === "build_export_contacts"
    )!
    const exportPage = async (input: Record<string, unknown>) =>
      (await exportOperation.execute(
        context,
        exportOperation.schema.parse(input)
      )) as Awaited<ReturnType<typeof exportContacts>>
    const exportedIds: string[] = []
    cursor = undefined
    do {
      const page = await exportPage({
        agentId: "support",
        format: "json",
        limit: 1,
        cursor,
      })
      if (typeof page.items === "string")
        throw new Error("Expected JSON contacts")
      exportedIds.push(...page.items.map((contact) => contact.id))
      cursor = page.nextCursor ?? undefined
    } while (cursor && exportedIds.length < 10)
    expect(cursor).toBeUndefined()
    expect(exportedIds).toEqual(expectedIds)
    const csv = await exportPage({
      agentId: "support",
      format: "csv",
      search: "Linked",
      status: "blocked",
    })
    expect(typeof csv.items).toBe("string")
    expect((csv.items as string).split("\n")).toHaveLength(2)
    expect(csv.items).toContain(linked[2]!.id)
  } finally {
    await closeTracerFixture(database)
  }
}, 30_000)
