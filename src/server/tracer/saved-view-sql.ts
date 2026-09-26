import { sql, type SQL } from "drizzle-orm"
import type {
  SavedView,
  SavedViewDataQuery,
  SavedViewRow,
} from "@/src/lib/tracer/contracts"
import { parseSelector } from "@/src/lib/tracer/selectors"
import { safeJson } from "../semantic/sql-filters"
import { ReadBudgetError, READ_MAX_BYTES } from "../semantic/read-budget"
import type { TracerDatabase } from "./db"
import { validation } from "./errors"

export async function savedViewSql(
  database: TracerDatabase,
  project: string,
  view: SavedView,
  query: SavedViewDataQuery
) {
  if (
    query.offset !== undefined &&
    (!Number.isSafeInteger(query.offset) || query.offset < 0)
  )
    throw validation("offset must be a nonnegative integer.")
  const trace = sql`jsonb_build_object('id',t.id,'name',t.name,'operation',t.operation,'sessionId',t.session_id,'input',${safeJson(sql`coalesce(t.input_json,'null')`)},'output',${safeJson(sql`coalesce(t.output_json,'null')`)},'attributes',${safeJson(sql`t.attributes_json`)},'startedAt',t.started_at,'endedAt',t.ended_at,'status',t.status,'durationMs',case when t.ended_at_ms >= t.started_at_ms then t.ended_at_ms-t.started_at_ms end,'group',case when t.group_name is null then null else jsonb_build_object('type',t.group_type,'name',t.group_name,'version',t.group_version) end)`
  const dataset = sql`case when d.id is null then null else jsonb_build_object('id',d.id,'datasetId',d.dataset_id,'input',${safeJson(sql`d.input_json`)},'expectedOutput',${safeJson(sql`coalesce(d.expected_output_json,'null')`)},'metadata',${safeJson(sql`d.metadata_json`)},'sourceTraceId',d.source_trace_id,'createdAt',d.created_at,'updatedAt',d.updated_at) end`
  const evaluator = sql`jsonb_build_object('id',r.evaluator_id,'name',coalesce(e.name,'Unknown evaluator'),'version',coalesce(v.version,0))`
  const result = sql`jsonb_build_object('id',r.id,'runId',r.run_id,'traceId',r.trace_id,'datasetItemId',r.dataset_item_id,'evaluatorId',r.evaluator_id,'evaluatorName',coalesce(e.name,'Unknown evaluator'),'evaluatorVersion',coalesce(v.version,0),'score',r.score,'passed',r.passed,'status',r.status,'error',r.error,'reasoning',r.reasoning,'metadata',${safeJson(sql`r.metadata_json`)},'completedAt',r.completed_at)`
  const records =
    view.resource === "traces"
      ? sql`select t.id,jsonb_build_object('trace',${trace}) as doc from traces t where t.project_id=${project}`
      : sql`select r.id,jsonb_build_object('trace',${trace},'datasetItem',${dataset},'evaluator',${evaluator},'result',${result}) as doc
      from eval_results r left join traces t on t.project_id=${project} and t.id=r.trace_id
      left join dataset_items d on d.project_id=${project} and d.id=r.dataset_item_id
      left join evaluators e on e.project_id=${project} and e.id=r.evaluator_id
      left join evaluator_versions v on v.project_id=${project} and v.id=r.evaluator_version_id
      where r.project_id=${project} ${query.runId ? sql`and r.run_id=${query.runId}` : sql``}`
  const selector = (name: string): SQL => {
    const path = parseSelector(name)
    if (!path) throw validation("Invalid saved-view selector.")
    return sql`doc #> array[${sql.join(
      path.map((segment) => sql`${segment}::text`),
      sql`, `
    )}]`
  }
  const filters = view.filters.map((filter) => {
    const value = selector(filter.selector)
    if (filter.operator === "exists")
      return sql`${value} is not null and ${value} <> 'null'::jsonb`
    const match = sql`coalesce(${value} = ${JSON.stringify(filter.value ?? null)}::jsonb,false)`
    return filter.operator === "equals" ? match : sql`not (${match})`
  })
  const limit = Math.max(1, Math.min(query.limit ?? 50, 200)),
    offset = Math.max(0, query.offset ?? 0)
  const values = sql`jsonb_build_object(${sql.join(
    view.columns.flatMap((c) => [sql`${c.id}::text`, selector(c.selector)]),
    sql`, `
  )})`
  const order = view.sort
    ? sql`${selector(view.sort.selector)} ${view.sort.direction === "asc" ? sql`asc nulls first` : sql`desc nulls last`}, id`
    : sql`id`
  const resultPage =
    await database.execute(sql`with records as (${records}), filtered as (select * from records where ${filters.length ? sql.join(filters, sql` and `) : sql`true`}),
    page as (select id,row_number() over(order by ${order}) as ordinal,${values} as values from filtered order by ${order} limit ${limit} offset ${offset})
    select case when (select coalesce(sum(octet_length(row_to_json(page)::text)),0) from page) <= ${READ_MAX_BYTES}
      then coalesce((select jsonb_agg(to_jsonb(page)-'ordinal' order by ordinal) from page),'[]'::jsonb) else null end as rows,
      (select count(*) from filtered) as total`)
  const row = resultPage.rows[0] as {
    rows: SavedViewRow[] | null
    total: string
  }
  if (!row.rows)
    throw new ReadBudgetError(
      "READ_RESULT_TOO_LARGE",
      "The saved-view page exceeds 8 MiB. Request fewer rows or narrower columns."
    )
  return {
    view,
    columns: view.columns,
    rows: row.rows,
    total: Number(row.total),
    limit,
    offset,
    nextOffset: offset + limit < Number(row.total) ? offset + limit : null,
  }
}
