import { mkdir, open } from "node:fs/promises"
import { dirname } from "node:path"
import { parseArgs } from "node:util"
import { Pool } from "pg"
import { PricingCatalog } from "../src/lib/tracer/pricing-catalog"
import {
  planCostBackfill,
  type CostBackfillSpan,
} from "../src/lib/tracer/cost-backfill"
import type { JsonObject } from "../src/lib/tracer/contracts"

type Options = {
  projectId: string
  model: string
  after: string
  before: string
  apply?: boolean
  backup?: string
}

/** Explicitly bounded, idempotent repair. Dry-run by default. Keep a durable
 * before-image on the server before committing each trace's cost changes. */
export async function runCostBackfill(
  options: Options,
  pricing = new PricingCatalog()
) {
  const after = Date.parse(options.after)
  const before = Date.parse(options.before)
  if (
    !options.projectId ||
    !options.model ||
    !Number.isFinite(after) ||
    !Number.isFinite(before) ||
    before <= after ||
    before - after > 31 * 86400000
  )
    throw new Error(
      "Require project, exact model and a valid window of at most 31 days"
    )
  if (options.apply && !options.backup)
    throw new Error("Apply requires a backup path")
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  const snapshot = await pricing.get()
  if (!snapshot.fetchedAt)
    throw new Error("A fresh pricing catalog is required for backfill")
  const runId = crypto.randomUUID()
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  const backup = options.apply
    ? await (async () => {
        await mkdir(dirname(options.backup!), { recursive: true, mode: 0o700 })
        return open(options.backup!, "wx", 0o600)
      })()
    : undefined
  const report = {
    runId,
    apply: !!options.apply,
    projectId: options.projectId,
    model: options.model,
    after: options.after,
    before: options.before,
    catalogFetchedAt: snapshot.fetchedAt,
    traces: 0,
    pricedSpans: 0,
    updatedWrappers: 0,
    addedUsd: 0,
    backup: options.backup,
  }
  try {
    const project = await pool.query("select id from project where id=$1", [
      options.projectId,
    ])
    if (!project.rowCount) throw new Error("Project not found")
    const candidates = await pool.query<{ id: string }>(
      `
      select t.id from traces t where t.project_id=$1 and t.started_at_ms >= $2 and t.started_at_ms < $3
      and t.status in ('completed','errored','cancelled') and exists (
        select 1 from spans s where s.project_id=t.project_id and s.trace_id=t.id
        and s.kind='llm' and s.cost_status='missing'
        and coalesce(s.attributes_json->>'gen_ai.response.model',s.attributes_json->>'ai.response.model',
          s.attributes_json->>'gen_ai.request.model',s.attributes_json->>'ai.model.id',s.attributes_json->>'model')=$4)
      order by t.id limit 1001`,
      [options.projectId, after, before, options.model]
    )
    if (candidates.rows.length > 1000)
      throw new Error("More than 1000 traces; narrow the window")
    for (const candidate of candidates.rows) {
      const client = await pool.connect()
      try {
        await client.query(options.apply ? "BEGIN" : "BEGIN READ ONLY")
        await client.query("SET LOCAL statement_timeout='15s'")
        await client.query("SET LOCAL lock_timeout='5s'")
        const trace = await client.query<{ attributes_json: JsonObject }>(
          `
          select attributes_json from traces where project_id=$1 and id=$2
          and status in ('completed','errored','cancelled') ${options.apply ? "for update" : ""}`,
          [options.projectId, candidate.id]
        )
        if (!trace.rowCount) {
          await client.query("ROLLBACK")
          continue
        }
        const spans = await client.query<CostBackfillSpan>(
          `
          select id,parent_id as "parentId",kind,attributes_json as attributes from spans
          where project_id=$1 and trace_id=$2 order by id limit 10001 ${options.apply ? "for update" : ""}`,
          [options.projectId, candidate.id]
        )
        if (spans.rows.length > 10000)
          throw new Error("More than 10000 spans in a trace")
        const plan = planCostBackfill(
          trace.rows[0].attributes_json,
          spans.rows,
          snapshot,
          options.model,
          runId
        )
        if (plan.priced && options.apply) {
          await backup!.write(
            JSON.stringify({
              runId,
              projectId: options.projectId,
              traceId: candidate.id,
              traceBefore: trace.rows[0].attributes_json,
              spansBefore: spans.rows.filter((s) => plan.changed.has(s.id)),
              traceAfter: plan.trace,
              spansAfter: [...plan.changed],
              catalogFetchedAt: snapshot.fetchedAt,
            }) + "\n"
          )
          await backup!.sync()
          for (const [id, attributes] of plan.changed)
            await client.query(
              "update spans set attributes_json=$1::jsonb where project_id=$2 and trace_id=$3 and id=$4",
              [JSON.stringify(attributes), options.projectId, candidate.id, id]
            )
          await client.query(
            "update traces set attributes_json=$1::jsonb where project_id=$2 and id=$3",
            [JSON.stringify(plan.trace), options.projectId, candidate.id]
          )
        }
        await client.query("COMMIT")
        report.traces += plan.priced > 0 ? 1 : 0
        report.pricedSpans += plan.priced
        report.updatedWrappers += plan.changed.size - plan.priced
        report.addedUsd += plan.addedUsd
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }
    }
    console.info(JSON.stringify(report))
    return report
  } finally {
    await backup?.close()
    await pool.end()
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      project: { type: "string" },
      model: { type: "string" },
      after: { type: "string" },
      before: { type: "string" },
      backup: { type: "string" },
      apply: { type: "boolean", default: false },
    },
  })
  await runCostBackfill({
    projectId: values.project ?? "",
    model: values.model ?? "",
    after: values.after ?? "",
    before: values.before ?? "",
    apply: values.apply,
    backup: values.backup,
  })
}
