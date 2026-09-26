import { sql } from "drizzle-orm"
import type { TracerDatabase } from "./db"
import { safeJson } from "../semantic/sql-filters"

/** Resolve unique matches over the complete remaining populations before paging. */
export async function evalPairIds(
  database: TracerDatabase,
  project: string,
  left: string,
  right: string,
  offset = 0,
  limit = 50
) {
  const doc = safeJson(sql`snapshot_json`)
  const result = await database.execute(sql`with all_targets as materialized (
    select t.id,t.run_id,t.ordinal,coalesce(t.dataset_item_id,${doc} #>> '{datasetItem,id}') as dataset_item_id,t.trace_id,
      coalesce(${doc} #> '{trace,input}',${safeJson(sql`coalesce(tr.input_json,'null')`)}) as input
    from eval_run_targets t join traces tr on tr.project_id=${project} and tr.id=t.trace_id
    where t.project_id=${project} and t.run_id in (${left},${right})
  ), item_keys as (
    select *,count(*) over(partition by run_id,dataset_item_id) as n from all_targets where dataset_item_id is not null
  ), item_pairs as (
    select l.id as lid,r.id as rid,'dataset item'::text as matched from item_keys l join item_keys r on l.dataset_item_id=r.dataset_item_id
    where l.run_id=${left} and r.run_id=${right} and l.n=1 and r.n=1
  ), after_items as (
    select * from all_targets a where not exists(select 1 from item_pairs p where a.id=p.lid or a.id=p.rid)
  ), trace_keys as (
    select *,count(*) over(partition by run_id,trace_id) as n from after_items
  ), trace_pairs as (
    select l.id as lid,r.id as rid,'trace'::text as matched from trace_keys l join trace_keys r on l.trace_id=r.trace_id
    where l.run_id=${left} and r.run_id=${right} and l.n=1 and r.n=1
  ), after_traces as (
    select * from after_items a where not exists(select 1 from trace_pairs p where a.id=p.lid or a.id=p.rid)
  ), input_keys as (
    select *,count(*) over(partition by run_id,input) as n from after_traces where input <> 'null'::jsonb and input <> '""'::jsonb
  ), input_pairs as (
    select l.id as lid,r.id as rid,'input'::text as matched from input_keys l join input_keys r on l.input=r.input
    where l.run_id=${left} and r.run_id=${right} and l.n=1 and r.n=1
  ), matches as (select * from item_pairs union all select * from trace_pairs union all select * from input_pairs),
  pairs as (
    select a.id as lid,m.rid,m.matched,0 as side,a.ordinal from all_targets a left join matches m on m.lid=a.id where a.run_id=${left}
    union all select null::text,a.id,null::text,1,a.ordinal from all_targets a where a.run_id=${right} and not exists(select 1 from matches m where m.rid=a.id)
  ), page as (select * from pairs order by side,ordinal,lid,rid limit ${limit} offset ${offset})
  select coalesce((select jsonb_agg(to_jsonb(page)) from page),'[]'::jsonb) as pairs,(select count(*) from pairs) as total`)
  const row = result.rows[0] as {
    pairs: {
      lid: string | null
      rid: string | null
      matched: "dataset item" | "trace" | "input" | null
    }[]
    total: string
  }
  return {
    pairs: row.pairs,
    total: Number(row.total),
    offset,
    limit,
    nextOffset: offset + limit < Number(row.total) ? offset + limit : null,
  }
}
