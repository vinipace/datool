import { sql } from "drizzle-orm"
import { z } from "zod"

import {
  contactIdentityInputSchema,
  contactInputSchema,
  contactStatusSchema,
  operationsPageSchema,
  operationsChannelSchema,
} from "@/src/lib/build/contracts"
import type { BuildContext } from "../context"
import { operationId } from "../context"
import {
  assertChanged,
  decodeJson,
  ensureRows,
  iso,
  jsonValue,
  pageCursor,
  pageLimit,
  prepareOperations,
  sqlAnd,
} from "./database"

type ContactRow = {
  id: string
  project_id: string
  external_id: string | null
  display_name: string
  email: string | null
  phone: string | null
  status: string
  metadata_json: unknown
  created_at: unknown
  updated_at: unknown
  last_seen_at: unknown
}

function contact(row: ContactRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    externalId: row.external_id,
    displayName: row.display_name,
    email: row.email,
    phone: row.phone,
    status: contactStatusSchema.parse(row.status),
    metadata: decodeJson<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    lastSeenAt: iso(row.last_seen_at),
  }
}

const contactPageSchema = operationsPageSchema.extend({
  status: contactStatusSchema.optional(),
  search: z.string().max(300).optional(),
})

export async function createContact(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = contactInputSchema.strict().parse(value)
  return ctx.database.transaction(async (tx) => {
    const existing = input.externalId
      ? await tx.execute<ContactRow>(sql`
          select * from build_contacts
          where project_id=${ctx.projectId} and external_id=${input.externalId}
          for update
        `)
      : { rows: [] as ContactRow[] }
    const timestamp = new Date().toISOString()
    if (existing.rows[0]) {
      const row = existing.rows[0]
      await tx.execute(sql`
        update build_contacts
        set display_name=${input.displayName ?? row.display_name},
            email=${input.email ?? row.email}, phone=${input.phone ?? row.phone},
            status=${input.status}, metadata_json=metadata_json || ${jsonValue(input.metadata)},
            updated_at=${timestamp}, last_seen_at=${timestamp}
        where project_id=${ctx.projectId} and id=${row.id}
      `)
      const updated = await tx.execute<ContactRow>(sql`
        select * from build_contacts where project_id=${ctx.projectId} and id=${row.id}
      `)
      return contact(ensureRows(updated.rows, "Contact", row.id))
    }
    const id = operationId("contact")
    await tx.execute(sql`
      insert into build_contacts
        (id,project_id,external_id,display_name,email,phone,status,metadata_json,created_at,updated_at,last_seen_at)
      values
        (${id},${ctx.projectId},${input.externalId ?? null},${input.displayName ?? ""},${input.email ?? null},${input.phone ?? null},${input.status},${jsonValue(input.metadata)},${timestamp},${timestamp},${timestamp})
    `)
    const inserted = await tx.execute<ContactRow>(sql`
      select * from build_contacts where project_id=${ctx.projectId} and id=${id}
    `)
    return contact(ensureRows(inserted.rows, "Contact", id))
  })
}

export async function getContact(context: BuildContext, id: string) {
  const ctx = await prepareOperations(context)
  const result = await ctx.database.execute<ContactRow>(sql`
    select * from build_contacts where project_id=${ctx.projectId} and id=${id}
  `)
  return contact(ensureRows(result.rows, "Contact", id))
}

export async function updateContact(context: BuildContext, id: string, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = contactInputSchema.partial().strict().parse(value)
  const timestamp = new Date().toISOString()
  const result = await ctx.database.execute(sql`
    update build_contacts set
      external_id=coalesce(${input.externalId ?? null},external_id),
      display_name=coalesce(${input.displayName ?? null},display_name),
      email=coalesce(${input.email ?? null},email),
      phone=coalesce(${input.phone ?? null},phone),
      status=coalesce(${input.status ?? null},status),
      metadata_json=metadata_json || ${jsonValue(input.metadata ?? {})},
      updated_at=${timestamp}
    where project_id=${ctx.projectId} and id=${id}
  `)
  assertChanged(result, `Contact '${id}' was changed or deleted before this update.`)
  return getContact(ctx, id)
}

export async function listContacts(context: BuildContext, value?: unknown) {
  const ctx = await prepareOperations(context)
  const input = contactPageSchema.parse(value ?? {})
  const limit = pageLimit(input.limit)
  const predicates = [sql`project_id=${ctx.projectId}`]
  if (input.status) predicates.push(sql`status=${input.status}`)
  if (input.cursor) predicates.push(sql`id>${pageCursor(input.cursor)}`)
  if (input.search) {
    const query = `%${input.search}%`
    predicates.push(sql`(display_name ilike ${query} or email ilike ${query} or phone ilike ${query} or external_id ilike ${query})`)
  }
  const result = await ctx.database.execute<ContactRow>(sql`
    select * from build_contacts where ${sqlAnd(predicates)} order by id asc limit ${limit + 1}
  `)
  const rows = result.rows.slice(0, limit)
  return {
    items: rows.map(contact),
    nextCursor: result.rows.length > limit ? rows.at(-1)?.id ?? null : null,
  }
}

type IdentityRow = {
  id: string
  project_id: string
  contact_id: string
  channel: string
  identity_key: string
  display_name: string | null
  verified: boolean
  metadata_json: unknown
  created_at: unknown
  updated_at: unknown
}

function identity(row: IdentityRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    contactId: row.contact_id,
    channel: operationsChannelSchema.parse(row.channel),
    identityKey: row.identity_key,
    displayName: row.display_name,
    verified: row.verified,
    metadata: decodeJson<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export async function upsertContactIdentity(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = contactIdentityInputSchema.strict().parse(value)
  return ctx.database.transaction(async (tx) => {
    const contactResult = await tx.execute(sql`
      select 1 from build_contacts where project_id=${ctx.projectId} and id=${input.contactId}
    `)
    if (!contactResult.rows[0]) throw new Error(`Contact '${input.contactId}' was not found.`)
    const timestamp = new Date().toISOString()
    const current = await tx.execute<IdentityRow>(sql`
      select * from build_contact_identities
      where project_id=${ctx.projectId} and channel=${input.channel} and identity_key=${input.identityKey}
      for update
    `)
    const id = current.rows[0]?.id ?? operationId("identity")
    await tx.execute(sql`
      insert into build_contact_identities
        (id,project_id,contact_id,channel,identity_key,display_name,verified,metadata_json,created_at,updated_at)
      values
        (${id},${ctx.projectId},${input.contactId},${input.channel},${input.identityKey},${input.displayName ?? null},${input.verified},${jsonValue(input.metadata)},${timestamp},${timestamp})
      on conflict (project_id,channel,identity_key) do update set
        contact_id=excluded.contact_id, display_name=excluded.display_name,
        verified=excluded.verified, metadata_json=excluded.metadata_json, updated_at=excluded.updated_at
    `)
    const result = await tx.execute<IdentityRow>(sql`
      select * from build_contact_identities where project_id=${ctx.projectId} and id=${id}
    `)
    return identity(ensureRows(result.rows, "Contact identity", id))
  })
}

export async function listContactIdentities(context: BuildContext, contactId: string) {
  const ctx = await prepareOperations(context)
  const result = await ctx.database.execute<IdentityRow & {
    connection_id: string | null
    connection_label: string | null
    connection_status: string | null
  }>(sql`
    select i.*, c.id as connection_id, c.label as connection_label, c.status as connection_status
    from build_contact_identities i
    left join build_channel_connection c
      on c.project_id=i.project_id and c.channel=i.channel
      and starts_with(i.identity_key,c.id::text || ':')
    where i.project_id=${ctx.projectId} and i.contact_id=${contactId}
    order by i.channel asc, i.identity_key asc limit 100
  `)
  return result.rows.map((row) => ({
    ...identity(row),
    externalId: row.connection_id ? row.identity_key.slice(row.connection_id.length + 1) : row.identity_key,
    connection: row.connection_id ? {
      id: row.connection_id,
      label: row.connection_label!,
      status: row.connection_status!,
    } : null,
  }))
}

export async function setContactAttribute(
  context: BuildContext,
  input: { contactId: string; key: string; value: unknown; source?: string }
) {
  const ctx = await prepareOperations(context)
  if (!input.key.trim() || input.key.length > 120) throw new Error("Attribute key is required and must be at most 120 characters.")
  const source = input.source ?? "manual"
  if (!["manual", "import", "conversation", "campaign"].includes(source)) throw new Error("Attribute source is invalid.")
  await ctx.database.execute(sql`
    insert into build_contact_attributes(project_id,contact_id,attribute_key,value_json,source,updated_at)
    values (${ctx.projectId},${input.contactId},${input.key.trim()},${jsonValue(input.value)},${source},now())
    on conflict (project_id,contact_id,attribute_key) do update set value_json=excluded.value_json, source=excluded.source, updated_at=excluded.updated_at
  `)
  return { projectId: ctx.projectId, contactId: input.contactId, key: input.key.trim(), value: input.value, source }
}

export async function listContactAttributes(context: BuildContext, contactId: string) {
  const ctx = await prepareOperations(context)
  const result = await ctx.database.execute<{ attribute_key: string; value_json: unknown; source: string; updated_at: unknown }>(sql`
    select attribute_key,value_json,source,updated_at from build_contact_attributes
    where project_id=${ctx.projectId} and contact_id=${contactId} order by attribute_key asc limit 1000
  `)
  return result.rows.map((row) => ({ key: row.attribute_key, value: decodeJson(row.value_json, null), source: row.source, updatedAt: iso(row.updated_at) }))
}

export async function importContacts(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({
    source: z.enum(["mcp", "csv", "api"]).default("mcp"),
    rows: z.array(contactInputSchema).min(1).max(1_000),
  }).strict().parse(value)
  const importId = operationId("contact_import")
  let imported = 0
  let skipped = 0
  const errors: Array<{ index: number; error: string }> = []
  await ctx.database.transaction(async (tx) => {
    await tx.execute(sql`
      insert into build_contact_imports(id,project_id,source,row_count) values (${importId},${ctx.projectId},${input.source},${input.rows.length})
    `)
    for (const [index, row] of input.rows.entries()) {
      try {
        const existing = row.externalId
          ? await tx.execute<{ id: string }>(sql`select id from build_contacts where project_id=${ctx.projectId} and external_id=${row.externalId} for update`)
          : { rows: [] as Array<{ id: string }> }
        const id = existing.rows[0]?.id ?? operationId("contact")
        await tx.execute(sql`
          insert into build_contacts(id,project_id,external_id,display_name,email,phone,status,metadata_json,created_at,updated_at,last_seen_at)
          values (${id},${ctx.projectId},${row.externalId ?? null},${row.displayName ?? ""},${row.email ?? null},${row.phone ?? null},${row.status},${jsonValue(row.metadata)},now(),now(),now())
          on conflict (project_id,external_id) where external_id is not null do update set display_name=excluded.display_name,email=excluded.email,phone=excluded.phone,status=excluded.status,metadata_json=build_contacts.metadata_json || excluded.metadata_json,updated_at=now(),last_seen_at=now()
        `)
        imported += 1
      } catch (error) {
        skipped += 1
        errors.push({ index, error: error instanceof Error ? error.message : "Import row failed." })
      }
    }
    await tx.execute(sql`
      update build_contact_imports set status=${errors.length ? "failed" : "completed"}, imported_count=${imported}, skipped_count=${skipped}, error_json=${jsonValue(errors)}, completed_at=now() where id=${importId} and project_id=${ctx.projectId}
    `)
  })
  return { id: importId, rowCount: input.rows.length, importedCount: imported, skippedCount: skipped, errors }
}

export async function requestContactExport(context: BuildContext, value?: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({ format: z.enum(["json", "csv"]).default("json"), filter: z.record(z.string(), z.json()).default({}) }).strict().parse(value ?? {})
  const id = operationId("contact_export")
  await ctx.database.execute(sql`
    insert into build_contact_exports(id,project_id,format,filter_json) values (${id},${ctx.projectId},${input.format},${jsonValue(input.filter)})
  `)
  return { id, projectId: ctx.projectId, format: input.format, status: "ready" as const }
}

export async function exportContacts(context: BuildContext, value?: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({ format: z.enum(["json", "csv"]).default("json"), limit: z.number().int().min(1).max(1_000).default(1_000), cursor: z.string().max(256).optional() }).strict().parse(value ?? {})
  const predicates = [sql`project_id=${ctx.projectId}`]
  if (input.cursor) predicates.push(sql`id>${input.cursor}`)
  const result = await ctx.database.execute<ContactRow>(sql`
    select * from build_contacts where ${sqlAnd(predicates)} order by id asc limit ${input.limit + 1}
  `)
  const rows = result.rows.slice(0, input.limit).map(contact)
  const payload = input.format === "csv"
    ? ["id,externalId,displayName,email,phone,status", ...rows.map((row) => [row.id,row.externalId,row.displayName,row.email,row.phone,row.status].map((cell) => JSON.stringify(cell ?? "")).join(","))].join("\n")
    : rows
  return { format: input.format, items: payload, nextCursor: result.rows.length > input.limit ? rows.at(-1)?.id ?? null : null }
}

export async function collectData(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({ contactId: z.string().max(128).optional(), conversationId: z.string().max(256).optional(), fieldKey: z.string().trim().min(1).max(120), value: z.json(), source: z.enum(["conversation", "form", "action", "manual", "import"]).default("conversation") }).strict().parse(value)
  if (!input.contactId && !input.conversationId) throw new Error("Collected data requires contactId or conversationId.")
  const id = operationId("collected")
  await ctx.database.execute(sql`
    insert into build_collected_data(id,project_id,contact_id,conversation_id,field_key,value_json,source) values (${id},${ctx.projectId},${input.contactId ?? null},${input.conversationId ?? null},${input.fieldKey},${jsonValue(input.value)},${input.source})
  `)
  return { id, projectId: ctx.projectId, ...input }
}

export async function listCollectedData(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({ contactId: z.string().max(128).optional(), conversationId: z.string().max(256).optional(), limit: z.number().int().min(1).max(100).default(50), cursor: z.string().max(256).optional() }).strict().parse(value ?? {})
  if (!input.contactId && !input.conversationId) throw new Error("List collected data requires contactId or conversationId.")
  const predicates = [sql`project_id=${ctx.projectId}`]
  if (input.contactId) predicates.push(sql`contact_id=${input.contactId}`)
  if (input.conversationId) predicates.push(sql`conversation_id=${input.conversationId}`)
  if (input.cursor) predicates.push(sql`id>${input.cursor}`)
  const result = await ctx.database.execute<{ id: string; contact_id: string | null; conversation_id: string | null; field_key: string; value_json: unknown; source: string; created_at: unknown }>(sql`
    select * from build_collected_data where ${sqlAnd(predicates)} order by id asc limit ${input.limit + 1}
  `)
  const rows = result.rows.slice(0, input.limit)
  return { items: rows.map((row) => ({ id: row.id, contactId: row.contact_id, conversationId: row.conversation_id, fieldKey: row.field_key, value: decodeJson(row.value_json, null), source: row.source, createdAt: iso(row.created_at) })), nextCursor: result.rows.length > input.limit ? rows.at(-1)?.id ?? null : null }
}

export async function upsertLead(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({ id: z.string().max(128).optional(), contactId: z.string().max(128).optional(), conversationId: z.string().max(256).optional(), status: z.enum(["new", "qualified", "disqualified", "converted"]).default("new"), score: z.number().int().min(0).max(100).nullable().default(null), source: z.string().max(200).optional(), data: z.record(z.string(), z.json()).default({}) }).strict().parse(value)
  const id = input.id ?? operationId("lead")
  const result = await ctx.database.execute(sql`
    insert into build_leads(id,project_id,contact_id,conversation_id,status,score,source,data_json) values (${id},${ctx.projectId},${input.contactId ?? null},${input.conversationId ?? null},${input.status},${input.score},${input.source ?? null},${jsonValue(input.data)})
    on conflict (id) do update set contact_id=excluded.contact_id,conversation_id=excluded.conversation_id,status=excluded.status,score=excluded.score,source=excluded.source,data_json=excluded.data_json,updated_at=now()
      where build_leads.project_id=${ctx.projectId}
  `)
  if (!result.rowCount) throw new Error(`Lead '${id}' belongs to another project or could not be written.`)
  return { id, projectId: ctx.projectId, ...input }
}

export async function listLeads(context: BuildContext, value?: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({ status: z.enum(["new", "qualified", "disqualified", "converted"]).optional(), limit: z.number().int().min(1).max(100).default(50), cursor: z.string().max(256).optional() }).strict().parse(value ?? {})
  const predicates = [sql`project_id=${ctx.projectId}`]
  if (input.status) predicates.push(sql`status=${input.status}`)
  if (input.cursor) predicates.push(sql`id>${input.cursor}`)
  const result = await ctx.database.execute<{ id: string; contact_id: string | null; conversation_id: string | null; status: string; score: number | null; source: string | null; data_json: unknown; created_at: unknown; updated_at: unknown }>(sql`select * from build_leads where ${sqlAnd(predicates)} order by id asc limit ${input.limit + 1}`)
  const rows = result.rows.slice(0, input.limit)
  return { items: rows.map((row) => ({ id: row.id, contactId: row.contact_id, conversationId: row.conversation_id, status: row.status, score: row.score, source: row.source, data: decodeJson(row.data_json, {}), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })), nextCursor: result.rows.length > input.limit ? rows.at(-1)?.id ?? null : null }
}
