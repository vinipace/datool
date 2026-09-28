import { sql } from "drizzle-orm"
import { z } from "zod"
import { getTracerProjectId, scopedTracerTransaction, type TracerDatabase } from "./db"
import { tracerEffect, runTracerEffect } from "./effect"
import { notFound, TracerError, validation } from "./errors"
import { workspaceIdentity } from "../auth/context"
import { customViewInputSchema, customViewSchema, customViewUpdateSchema } from "@/src/lib/tracer/custom-views"
import { customFieldInputSchema, customFieldSchema, customFieldUpdateSchema } from "@/src/lib/tracer/custom-fields"
import { createObjectViewSchema, updateObjectViewSchema } from "@/src/lib/tracer/object-views"
import { reactViewSchema } from "@/src/lib/tracer/react-views"
import { viewPreferenceSchema, pageViewResources, type ViewResourceKind } from "@/src/lib/tracer/view-resources"
import { fieldEvaluationSchema, objectPreviewSchema } from "@/src/lib/tracer/view-operations"
import { evaluateCustomField, previewObjectView } from "./view-execution"
import { requireScopes } from "../auth/request"
import { createCustomViewService } from "./custom-views"
import { createReactViewService } from "./react-views"
import { savedViewSql } from "./saved-view-sql"

const tables = { "page-view": "custom_views", "custom-field": "custom_fields", "object-view": "react_views" } as const
type Row = Record<string, unknown>
const json = (value: unknown) => typeof value === "string" ? JSON.parse(value) : value
function decode(kind: ViewResourceKind, row: Row) {
  if (kind === "page-view") return customViewSchema.parse({
    id: row.id, name: row.name, resource: row.resource, settings: json(row.settings_json),
    revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
  })
  if (kind === "custom-field") return customFieldSchema.parse({
    ...json(row.definition_json), id: row.id, revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at,
  })
  return reactViewSchema.parse({
    id: row.id, projectId: row.project_id, name: row.name, description: row.description,
    code: row.code, dataMode: row.data_mode, requirements: row.requirements,
    origin: row.origin, author: row.author, revision: row.revision,
    objectTypes: row.object_types, inputContract: row.input_contract, customFields: row.custom_fields,
    createdAt: row.created_at, updatedAt: row.updated_at,
  })
}
export type ViewDefinition = ReturnType<typeof decode>
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw validation(parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "))
  return parsed.data
}
const conflict = () => new TracerError("CONFLICT", "This definition changed. Reload its current revision or save your draft as a copy.")

export function createViewLibrary(database: TracerDatabase, inTransaction = false) {
  const project = getTracerProjectId(database)
  const pages = createCustomViewService(database)
  const objects = createReactViewService(database)
  const get = async (kind: ViewResourceKind, id: string, revision?: number): Promise<ViewDefinition> => {
    if (revision !== undefined) {
      const result = await database.execute(sql`select definition from view_resource_versions where project_id=${project} and kind=${kind} and resource_id=${id} and revision=${revision}`)
      const row = result.rows[0]
      if (!row) throw notFound(kind + " revision", id)
      const schema = kind === "page-view" ? customViewSchema : kind === "custom-field" ? customFieldSchema : reactViewSchema
      return schema.parse(row.definition)
    }
    const result = await database.execute(sql`select * from ${sql.identifier(tables[kind])} where project_id=${project} and id=${id}`)
    if (!result.rows[0]) throw notFound(kind, id)
    return decode(kind, result.rows[0])
  }
  const assertReferences = async (kind: ViewResourceKind, input: unknown) => {
    const value = input as { settings?: { customFields?: { id: string; revision?: number }[]; computedColumns?: { id: string }[]; objectViews?: Record<string, { id: string; revision?: number } | null> }; customFields?: { id: string; revision?: number }[] }
    const fields = kind === "page-view" ? value.settings?.customFields ?? value.settings?.computedColumns : value.customFields
    for (const field of fields ?? []) await get("custom-field", field.id, "revision" in field && typeof field.revision === "number" ? field.revision : undefined)
    for (const view of Object.values(value.settings?.objectViews ?? {})) if (view) await get("object-view", view.id, view.revision)
  }
  const create = async (kind: ViewResourceKind, value: unknown): Promise<ViewDefinition> => {
    if (kind === "page-view") {
      const input = parse(customViewInputSchema, value)
      await assertReferences(kind, input)
      const settings = { ...input.settings, customFields: input.settings.customFields ?? input.settings.computedColumns.map(({ id }) => ({ id })), computedColumns: [] }
      return runTracerEffect(pages.create({ ...input, settings }))
    }
    if (kind === "object-view") {
      const input = parse(createObjectViewSchema, value)
      await assertReferences(kind, input)
      return runTracerEffect(objects.create(input))
    }
    const input = parse(customFieldInputSchema, value)
    const id = `field_${crypto.randomUUID()}`
    const now = new Date().toISOString()
    const result = await database.execute(sql`insert into custom_fields (id,project_id,name,name_key,definition_json,created_at,updated_at)
      values (${id},${project},${input.name},${input.name.toLocaleLowerCase()},${JSON.stringify({ ...input, id })},${now},${now})
      on conflict (project_id,name_key) do nothing returning *`)
    if (!result.rows[0]) throw validation("A Custom Field with that name already exists.")
    return decode(kind, result.rows[0])
  }
  const update = async (kind: ViewResourceKind, id: string, value: unknown): Promise<ViewDefinition> => {
    if (kind === "page-view") {
      const input = parse(customViewUpdateSchema, value)
      await assertReferences(kind, input)
      const settings = { ...input.settings, customFields: input.settings.customFields ?? input.settings.computedColumns.map(({ id }) => ({ id })), computedColumns: [] }
      const saved = await runTracerEffect(pages.update(id, { ...input, settings }))
      if (settings.query) {
        const query = settings.query
        // Keep the legacy selector API's semantics after a canonical update.
        await database.execute(sql`update saved_views set name=${saved.name},columns_json=${JSON.stringify(query.columns)},filters_json=${JSON.stringify(query.filters)},sort_json=${query.sort ? JSON.stringify(query.sort) : null},updated_at=${saved.updatedAt} where project_id=${project} and id=${id}`)
      }
      return saved
    }
    if (kind === "object-view") {
      const input = parse(updateObjectViewSchema, value)
      const previous = reactViewSchema.parse(await get(kind, id))
      if ((input.code !== previous.code || input.dataMode !== previous.dataMode) && JSON.stringify(input.requirements) === JSON.stringify(previous.requirements)) input.requirements = null
      await assertReferences(kind, input)
      return runTracerEffect(objects.update(id, input))
    }
    const { expectedRevision, ...input } = parse(customFieldUpdateSchema, value)
    const result = await database.execute(sql`update custom_fields set name=${input.name},name_key=${input.name.toLocaleLowerCase()},definition_json=${JSON.stringify({ ...input, id })} where project_id=${project} and id=${id} and revision=${expectedRevision} returning *`)
    if (!result.rows[0]) { await get(kind, id); throw conflict() }
    return decode(kind, result.rows[0])
  }
  const dependencies = async (kind: ViewResourceKind, id: string) => {
    if (kind === "page-view") return { items: [] }
    const rows = await database.execute(sql`select id,name,settings_json from custom_views where project_id=${project} and (
      settings_json::jsonb->'customFields' @> ${JSON.stringify([{ id }])}::jsonb or
      settings_json::jsonb->'computedColumns' @> ${JSON.stringify([{ id }])}::jsonb or
      exists(select 1 from jsonb_each(coalesce(settings_json::jsonb->'objectViews','{}'::jsonb)) as ref where ref.value->>'id'=${id})
    ) limit 101`)
    const items = rows.rows.flatMap(row => {
      const settings = json(row.settings_json) as { customFields?: { id: string }[]; computedColumns?: { id: string }[]; objectViews?: Record<string, { id: string } | null> }
      const refs = kind === "custom-field" ? [...settings.customFields ?? [], ...settings.computedColumns ?? []] : Object.values(settings.objectViews ?? {}).filter(Boolean)
      return refs.some(ref => ref?.id === id) ? [{ kind: "page-view", id: String(row.id), name: String(row.name) }] : []
    })
    if (kind === "custom-field") {
      const objects = await database.execute(sql`select id,name from react_views where project_id=${project} and custom_fields @> ${JSON.stringify([{ id }])}::jsonb limit 101`)
      items.push(...objects.rows.map(row => ({ kind: "object-view", id: String(row.id), name: String(row.name) })))
    }
    return { items: items.slice(0,100), hasMore: items.length > 100 }
  }
  const principal = () => {
    const identity = workspaceIdentity()
    if (!identity || identity.projectId !== project) throw new TracerError("UNAUTHORIZED", "A project identity is required for preferences.")
    return identity.userId ? `user:${identity.userId}` : identity.apiKeyId ? `api-key:${identity.apiKeyId}` : (() => { throw new TracerError("UNAUTHORIZED", "A stable preference identity is required.") })()
  }
  const mutate = <T>(action: (library: ReturnType<typeof createViewLibrary>) => import("./effect").TracerEffect<T>, direct: () => Promise<T>) => tracerEffect(async () => {
    if (inTransaction) return direct()
    return database.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${project}, 732))`)
      return runTracerEffect(action(createViewLibrary(scopedTracerTransaction(database, tx), true)))
    })
  })
  return {
    get: (kind: ViewResourceKind, id: string, revision?: number) => tracerEffect(() => get(kind, id, revision)),
    list: (kind: ViewResourceKind, value: unknown = {}) => tracerEffect(async () => {
      const options = parse(z.object({ cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(50), search: z.string().max(200).optional(), resource: z.string().optional() }).strict(), value)
      const rows = await database.execute(sql`select * from ${sql.identifier(tables[kind])} where project_id=${project}
        ${options.cursor ? sql`and id > ${options.cursor}` : sql``}
        ${options.search ? sql`and strpos(lower(name),lower(${options.search})) > 0` : sql``}
        ${options.resource && kind === "page-view" ? sql`and resource=${options.resource}` : sql``}
        order by id limit ${options.limit + 1}`)
      return { items: rows.rows.slice(0, options.limit).map(row => decode(kind, row)), nextCursor: rows.rows.length > options.limit ? String(rows.rows[options.limit - 1].id) : null }
    }),
    create: (kind: ViewResourceKind, value: unknown): import("./effect").TracerEffect<ViewDefinition> => mutate(s => s.create(kind, value), () => create(kind, value)),
    update: (kind: ViewResourceKind, id: string, value: unknown): import("./effect").TracerEffect<ViewDefinition> => mutate(s => s.update(kind, id, value), () => update(kind, id, value)),
    copy: (kind: ViewResourceKind, id: string, name: string) => tracerEffect(async () => {
      const saved = await get(kind, id)
      const input = kind === "page-view" ? customViewInputSchema.strip().parse(saved) : kind === "custom-field" ? customFieldInputSchema.strip().parse(saved) : { ...createObjectViewSchema.omit({ source: true }).strip().parse(saved), source: null }
      return create(kind, { ...input, name })
    }),
    dependencies: (kind: ViewResourceKind, id: string) => tracerEffect(async () => { await get(kind, id); return dependencies(kind, id) }),
    delete: (kind: ViewResourceKind, id: string, expectedRevision: number) => tracerEffect(async () => {
      parse(z.number().int().positive(), expectedRevision)
      const refs = await dependencies(kind, id)
      if (refs.items.length) throw validation("This definition is referenced. Remove or replace its references first.", { references: refs.items })
      const result = await database.execute(sql`delete from ${sql.identifier(tables[kind])} where project_id=${project} and id=${id} and revision=${expectedRevision} returning id`)
      if (!result.rows[0]) { await get(kind, id); throw conflict() }
      if (kind === "page-view") await database.execute(sql`delete from saved_views where project_id=${project} and id=${id}`)
      return { id }
    }),
    history: (kind: ViewResourceKind, id: string, before?: number) => tracerEffect(async () => {
      const rows = await database.execute(sql`select revision,definition,recorded_at from view_resource_versions where project_id=${project} and kind=${kind} and resource_id=${id} ${before ? sql`and revision < ${before}` : sql``} order by revision desc limit 51`)
      return { items: rows.rows.slice(0,50).map(row => ({ revision: Number(row.revision), definition: row.definition, recordedAt: String(row.recorded_at) })), nextCursor: rows.rows.length > 50 ? Number(rows.rows[49].revision) : null }
    }),
    restore: (kind: ViewResourceKind, id: string, revision: number, expectedRevision: number) => tracerEffect(async () => {
      const saved = await get(kind, id, revision)
      const schema = kind === "page-view" ? customViewInputSchema : kind === "custom-field" ? customFieldInputSchema : updateObjectViewSchema.omit({ expectedRevision: true })
      return update(kind, id, { ...schema.strip().parse(saved), expectedRevision })
    }),
    validate: (kind: ViewResourceKind, value: unknown) => tracerEffect(async () => {
      const schema = kind === "page-view" ? customViewInputSchema : kind === "custom-field" ? customFieldInputSchema : createObjectViewSchema
      const input = parse(schema as z.ZodType<unknown>, value)
      await assertReferences(kind, input)
      return { valid: true, evaluated: false, rendered: false }
    }),
    resolve: (id: string, revision?: number) => tracerEffect(async () => {
      const view = customViewSchema.parse(await get("page-view", id, revision))
      const fields = await Promise.all((view.settings.customFields ?? view.settings.computedColumns.map(field => ({ id: field.id, revision: undefined }))).map(ref => get("custom-field", ref.id, ref.revision)))
      const objectViews = Object.fromEntries(await Promise.all(Object.entries(view.settings.objectViews ?? {}).map(async ([kind, ref]) => [kind, ref ? await get("object-view", ref.id, ref.revision) : null] as const)))
      const params = new URLSearchParams()
      for (const [key, values] of Object.entries(view.settings.queryParams ?? {})) for (const value of values) params.append(key, value)
      params.set("pageView", id)
      if (revision) params.set("pageViewRevision", String(revision))
      return { view, fields, objectViews, path: `/${pageViewResources[view.resource].path}?${params}`, applied: false }
    }),
    evaluate: (value: unknown) => tracerEffect(async () => {
      const input = parse(fieldEvaluationSchema, value)
      return evaluateCustomField(customFieldSchema.parse(await get("custom-field", input.id, input.revision)), input.kind, input.rows)
    }),
    preview: (value: unknown) => tracerEffect(async () => {
      const input = parse(objectPreviewSchema, value)
      return previewObjectView(reactViewSchema.parse(await get("object-view", input.id, input.revision)), input.kind, input.object)
    }),
    data: (id: string, options: { limit?: number; offset?: number; runId?: string } = {}) => tracerEffect(async () => {
      const view = customViewSchema.parse(await get("page-view", id))
      if (!view.settings.query) throw validation("This Page View uses its page's collection query. Use the resource operation with settings.queryParams; no client-side filtering of a partial page is performed.")
      const query = view.settings.query
      requireScopes(workspaceIdentity()?.scopes ?? [], query.resource === "traces" ? ["traces:read"] : ["traces:read", "evals:read", "datasets:read"])
      return savedViewSql(database, project, { ...query, id, name: view.name, createdAt: view.createdAt, updatedAt: view.updatedAt }, options)
    }),
    preference: (scope: string) => tracerEffect(async () => {
      parse(z.string().min(1).max(500), scope)
      const rows = await database.execute(sql`select value,revision from view_preferences where project_id=${project} and principal_id=${principal()} and scope=${scope}`)
      return rows.rows[0] ? { scope, value: rows.rows[0].value, revision: Number(rows.rows[0].revision) } : { scope, value: {}, revision: 0 }
    }),
    savePreference: (value: unknown) => tracerEffect(async () => {
      const input = parse(viewPreferenceSchema, value)
      if (Buffer.byteLength(JSON.stringify(input.value)) > 65536) throw validation("Preferences exceed 64 KiB.")
      const who = principal()
      const result = input.expectedRevision === 0
        ? await database.execute(sql`insert into view_preferences(project_id,principal_id,scope,value) values(${project},${who},${input.scope},${JSON.stringify(input.value)}::jsonb) on conflict do nothing returning revision`)
        : await database.execute(sql`update view_preferences set value=${JSON.stringify(input.value)}::jsonb,revision=revision+1,updated_at=now() where project_id=${project} and principal_id=${who} and scope=${input.scope} and revision=${input.expectedRevision} returning revision`)
      if (!result.rows[0]) throw conflict()
      return { scope: input.scope, value: input.value, revision: Number(result.rows[0].revision) }
    }),
  }
}
