import { readCatalog, CATALOG_LIMIT } from "./catalog-read"
import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { getTracerProjectId, type TracerDatabase } from "./db"
import { tracerEffect } from "./effect"
import { validation } from "./errors"
import { customFields } from "./schema"
import type { ComputedColumn } from "@/src/lib/tracer/computed-columns"

const definition = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(120),
    code: z.string().max(20_000),
    mode: z.enum(["expression", "template"]),
    format: z.enum(["text", "markdown"]).default("text"),
  })
  .strict()
const decode = (row: typeof customFields.$inferSelect): ComputedColumn =>
  JSON.parse(row.definitionJson)
export function createCustomFieldService(db: TracerDatabase) {
  const projectId = getTracerProjectId(db)
  return {
    list: () =>
      tracerEffect(() =>
        readCatalog(
          db,
          sql`select * from ${customFields} where ${customFields.projectId}=${projectId}`,
          async (scoped) =>
            (
              await scoped
                .select()
                .from(customFields)
                .where(eq(customFields.projectId, projectId))
                .limit(CATALOG_LIMIT + 1)
            ).map(decode)
        )
      ),
    save: (value: unknown) =>
      tracerEffect(async () => {
        const input = z
          .object({ field: definition, overwrite: z.boolean().default(false) })
          .safeParse(value)
        if (!input.success) throw validation(input.error.message)
        const { field, overwrite } = input.data
        return db.transaction(async (tx) => {
          const rows = await tx
            .select()
            .from(customFields)
            .where(eq(customFields.projectId, projectId))
          const byId = rows.find((row) => row.id === field.id)
          const nameKey = field.name.toLocaleLowerCase()
          const byName = rows.find((row) => row.nameKey === nameKey)
          const same = (row: typeof customFields.$inferSelect) => {
            const existing = decode(row)
            return (
              existing.code === field.code &&
              existing.mode === field.mode &&
              (existing.format ?? "text") === field.format
            )
          }
          if (byName && byName.id !== field.id) {
            if (same(byName)) return decode(byName)
            throw validation(
              "A custom field with this name already exists. Select it or use a different name."
            )
          }
          if (byId && !overwrite) return decode(byId)
          const values = {
            projectId,
            id: field.id,
            name: field.name,
            nameKey,
            definitionJson: JSON.stringify(field),
          }
          if (byId)
            await tx
              .update(customFields)
              .set(values)
              .where(
                and(
                  eq(customFields.projectId, projectId),
                  eq(customFields.id, field.id)
                )
              )
          else await tx.insert(customFields).values(values)
          return field
        })
      }),
  }
}
