import { isDeepStrictEqual } from "node:util"
import { sql } from "drizzle-orm"
import { getTracerProjectId, type TracerDatabase } from "../../tracer/db"
import { analyticsAttributes, object } from "./mapper"

/** Fill missing analytical attributes from the immutable archive, preserving user edits. */
export async function backfillAnalytics(
  db: TracerDatabase,
  options: { dryRun?: boolean } = {}
) {
  const projectId = getTracerProjectId(db)
  const summary = {
    dryRun: !!options.dryRun,
    scanned: 0,
    changed: 0,
    conflicts: 0,
  }
  let after = ""
  for (;;) {
    const size = await db.transaction(async (tx) => {
      const rows = (
        await tx.execute<{
          id: string
          raw: unknown
        }>(sql`
        select e.id,e.raw from langfuse_import_entities e
        where e.project_id=${projectId} and e.kind='observations' and e.id>${after}
        order by e.id limit 100
      `)
      ).rows
      if (!rows.length) return 0
      // Bound the archive page before joining native data. Filtering JSON in the
      // paginated join can otherwise make PostgreSQL rescan every span per page.
      const spans = new Map(
        (
          await tx.execute<{
            id: string
            attributes: Record<string, unknown>
          }>(sql`
          select id,attributes_json as attributes from spans
          where project_id=${projectId} and id in (${sql.join(
            rows.map((row) => sql`${row.id}`),
            sql`,`
          )})
          for update
        `)
        ).rows.map((span) => [span.id, span.attributes])
      )
      for (const row of rows) {
        after = row.id
        const attributes = spans.get(row.id)
        if (!attributes) continue
        const provenance = attributes["import.source"]
        if (
          !provenance ||
          typeof provenance !== "object" ||
          Array.isArray(provenance)
        )
          continue
        const source = object(provenance)
        const raw = object(row.raw)
        if (
          source.provider !== "langfuse" ||
          source.kind !== "observations" ||
          source.id !== raw.id
        )
          continue
        summary.scanned++
        const desired = analyticsAttributes(raw)
        const patch: Record<string, unknown> = {}
        let conflict = false
        for (const [key, value] of Object.entries(desired)) {
          const existing = attributes[key]
          if (existing === undefined || existing === null) patch[key] = value
          else if (
            key === "cost.breakdown" &&
            typeof existing === "object" &&
            !Array.isArray(existing)
          ) {
            const merged = { ...(existing as Record<string, unknown>) }
            for (const [component, amount] of Object.entries(
              value as Record<string, unknown>
            )) {
              if (merged[component] === undefined || merged[component] === null)
                merged[component] = amount
              else if (!isDeepStrictEqual(merged[component], amount))
                conflict = true
            }
            if (!isDeepStrictEqual(existing, merged)) patch[key] = merged
          } else if (!isDeepStrictEqual(existing, value)) conflict = true
        }
        if (conflict) summary.conflicts++
        if (!Object.keys(patch).length) continue
        summary.changed++
        if (!options.dryRun)
          await tx.execute(sql`
          update spans set attributes_json=attributes_json || ${JSON.stringify(patch)}::jsonb
          where project_id=${projectId} and id=${row.id}
        `)
      }
      return rows.length
    })
    if (size < 100) break
  }
  return summary
}
