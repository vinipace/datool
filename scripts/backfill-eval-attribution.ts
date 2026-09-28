import { open, type FileHandle } from "node:fs/promises"
import { parseArgs } from "node:util"
import { Pool, type PoolClient } from "pg"
import { drizzle } from "drizzle-orm/node-postgres"
import { sql } from "drizzle-orm"
import { registerTracerProjectId } from "../src/server/tracer/db"
import * as schema from "../src/server/tracer/schema"
import {
  saveEvalAttributions,
  saveEvalRunGroups,
} from "../src/server/tracer/eval-attribution"
import {
  BackfillSkip,
  linkBackfillResults,
  prepareFrozenTarget,
  referenceKey,
  resolveFrozenTarget,
  validatedAttributions,
  type BackfillTargetIdentity,
  type BackfillResultIdentity,
  type GroupReference,
} from "../src/server/tracer/eval-attribution-backfill"
import {
  evalGroupKey,
  type EvalAttribution,
} from "../src/lib/tracer/eval-attribution"
import {
  invocationGroupSchema,
  type InvocationGroup,
} from "../src/lib/tracer/groups"
import { canonicalJson } from "../src/lib/tracer/resource-document"

type Options = {
  projectId: string
  before: string
  after?: string
  afterRun?: string
  limit?: number
  apply?: boolean
  backup?: string
  signal?: AbortSignal
}
const sameAttributions = (a: EvalAttribution[], b: EvalAttribution[]) => {
  const normalized = (items: EvalAttribution[]) =>
    items
      .map((item) => ({
        ...item,
        group: item.group
          ? { ...item.group, version: item.group.version ?? null }
          : null,
        models: [...new Set(item.models)].sort(),
      }))
      .sort((x, y) =>
        (x.group ? evalGroupKey(x.group) : "").localeCompare(
          y.group ? evalGroupKey(y.group) : ""
        )
      )
  return canonicalJson(normalized(a)) === canonicalJson(normalized(b))
}
class BackfillInputError extends Error {}
class BackfillRunError extends Error {}

const terminal = ["completed", "failed", "partial", "cancelled"]
const maxBytes = 32 * 1024 * 1024
async function audit(file: FileHandle | undefined, value: unknown) {
  if (file) {
    await file.writeFile(JSON.stringify(value) + "\n")
    await file.sync()
  }
}

async function immutableGroups(
  client: PoolClient,
  project: string,
  references: GroupReference[]
) {
  const groups = new Map<string, InvocationGroup | null>()
  for (let offset = 0; offset < references.length; offset += 500) {
    const rows = await client.query<{
      traceId: string
      spanId: string | null
      group: InvocationGroup | null
    }>(
      `
      with refs as (select * from jsonb_to_recordset($2::jsonb) as x("traceId" text,"spanId" text))
      select t.id as "traceId",null::text as "spanId",case when t.group_name is not null then jsonb_build_object('type',t.group_type,'name',t.group_name,'version',t.group_version) end as "group"
      from traces t join refs r on r."traceId"=t.id and r."spanId" is null where t.project_id=$1
      union all
      select s.trace_id,s.id,case when s.group_name is not null then jsonb_build_object('type',s.group_type,'name',s.group_name,'version',s.group_version) end
      from spans s join refs r on r."traceId"=s.trace_id and r."spanId"=s.id where s.project_id=$1`,
      [project, JSON.stringify(references.slice(offset, offset + 500))]
    )
    for (const row of rows.rows)
      groups.set(
        referenceKey(row),
        row.group ? invocationGroupSchema.parse(row.group) : null
      )
  }
  return groups
}

/** Bounded operator command: no scorer/app execution, migration or live evidence refresh. */
export async function runEvalAttributionBackfill(
  options: Options,
  databaseUrl = process.env.DATABASE_URL
) {
  const after = Date.parse(options.after ?? "1970-01-01T00:00:00Z")
  const before = Date.parse(options.before)
  const limit = options.limit ?? 100
  if (
    !options.projectId.trim() ||
    !Number.isFinite(after) ||
    !Number.isFinite(before) ||
    after >= before ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000
  )
    throw new BackfillInputError(
      "Require an exact project ID, a valid [after,before) window and limit 1–1000."
    )
  if (
    options.afterRun !== undefined &&
    !/^[A-Za-z0-9._:-]{1,128}$/.test(options.afterRun)
  )
    throw new BackfillInputError("Invalid after-run cursor.")
  if (
    !databaseUrl ||
    !["postgres:", "postgresql:"].includes(new URL(databaseUrl).protocol)
  )
    throw new BackfillInputError("DATABASE_URL must be a PostgreSQL URL.")
  if (options.apply && !options.backup)
    throw new BackfillInputError("Apply requires a new --backup JSONL path.")
  const batchId = crypto.randomUUID()
  const report = {
    batchId,
    mode: options.apply ? "apply" : "dry-run",
    projectId: options.projectId,
    after: new Date(after).toISOString(),
    before: new Date(before).toISOString(),
    scanned: 0,
    changed: 0,
    targets: 0,
    resultsLinked: 0,
    skipped: [] as { runId: string; reason: string }[],
    nextCursor: null as string | null,
    lastProcessedRun: options.afterRun ?? null,
    interrupted: false,
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    idle_in_transaction_session_timeout: 15000,
    application_name: "datool-eval-attribution-backfill",
  })
  let backup: FileHandle | undefined
  let client: PoolClient | undefined
  let locked = false
  try {
    client = await pool.connect()
    // Fail before opening the backup or modifying anything if required attribution migrations are absent.
    await client.query(
      "select r.groups_resolved_at,e.target_id,a.models_json,a.prompt_versions_json,g.group_name from eval_runs r,eval_results e,eval_target_attributions a,eval_run_groups g limit 0"
    )
    if (
      !(
        await client.query("select id from project where id=$1", [
          options.projectId,
        ])
      ).rowCount
    )
      throw new BackfillInputError("Project ID not found.")
    if (options.apply) {
      locked = (
        await client.query(
          "select pg_try_advisory_lock(hashtext('datool-eval-attribution-backfill'),hashtext($1)) as locked",
          [options.projectId]
        )
      ).rows[0].locked
      if (!locked)
        throw new BackfillInputError(
          "Another attribution backfill is already running for this project."
        )
      backup = await open(options.backup!, "wx", 0o600)
      await audit(backup, { type: "batch", ...report })
    }
    const candidates = await client.query<{ id: string }>(
      `select r.id from eval_runs r
      where r.project_id=$1 and r.created_at_ms >= $2 and r.created_at_ms < $3 and ($4::text is null or r.id>$4)
      and (r.groups_resolved_at is null or exists(select 1 from eval_results e where e.project_id=$1 and e.run_id=r.id and e.target_id is null))
      order by r.id limit $5`,
      [options.projectId, after, before, options.afterRun ?? null, limit + 1]
    )
    for (const { id } of candidates.rows.slice(0, limit)) {
      if (options.signal?.aborted) {
        report.interrupted = true
        report.nextCursor = report.lastProcessedRun
        break
      }
      try {
        await client.query(
          options.apply
            ? "BEGIN ISOLATION LEVEL REPEATABLE READ"
            : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
        )
        await client.query("SET LOCAL lock_timeout='1s'")
        const run = (
          await client.query<{
            status: string
            groups_resolved_at: string | null
          }>(
            `select status,groups_resolved_at from eval_runs where project_id=$1 and id=$2 ${options.apply ? "for update nowait" : ""}`,
            [options.projectId, id]
          )
        ).rows[0]
        if (!run || !terminal.includes(run.status))
          throw new BackfillSkip("run_not_terminal")
        if (
          (
            await client.query(
              "select 1 from eval_run_lease where run_id=$1 and expires_at>now()",
              [id]
            )
          ).rowCount
        )
          throw new BackfillSkip("active_execution_lease")
        const size = (
          await client.query(
            `select
          (select count(*)::integer from eval_run_targets where project_id=$1 and run_id=$2) as targets,
          (select count(*)::integer from eval_results where project_id=$1 and run_id=$2) as results,
          coalesce((select sum(octet_length(snapshot_json)) from eval_run_targets where project_id=$1 and run_id=$2),0)
          + coalesce((select sum(octet_length(metadata_json)) from eval_results where project_id=$1 and run_id=$2),0)
          + coalesce((select sum(octet_length(row_to_json(a)::text)) from eval_target_attributions a where project_id=$1 and run_id=$2),0)
          + coalesce((select sum(octet_length(row_to_json(g)::text)) from eval_run_groups g where project_id=$1 and run_id=$2),0) as bytes`,
            [options.projectId, id]
          )
        ).rows[0]
        if (!size.targets) throw new BackfillSkip("no_frozen_targets")
        if (
          size.targets > 10000 ||
          size.results > 100000 ||
          Number(size.bytes) > maxBytes
        )
          throw new BackfillSkip("run_exceeds_backfill_limit")
        const targets = (
          await client.query<
            BackfillTargetIdentity & { snapshot: string | null }
          >(
            `select id,trace_id as "traceId",dataset_item_id as "datasetItemId",snapshot_json as snapshot from eval_run_targets where project_id=$1 and run_id=$2 order by ordinal`,
            [options.projectId, id]
          )
        ).rows
        const results = (
          await client.query<BackfillResultIdentity>(
            `select id,target_id as "targetId",trace_id as "traceId",dataset_item_id as "datasetItemId",metadata_json as metadata from eval_results where project_id=$1 and run_id=$2`,
            [options.projectId, id]
          )
        ).rows
        const links = linkBackfillResults(targets, results)
        const saved = (
          await client.query<{ targetId: string; value: EvalAttribution }>(
            `select target_id as "targetId",jsonb_build_object('group',case when group_type is not null then jsonb_build_object('type',group_type,'name',group_name,'version',group_version) end,'models',models_json,'sourceTraceId',source_trace_id,'sourceSpanId',source_span_id) || case when jsonb_array_length(prompt_versions_json)>0 then jsonb_build_object('promptVersions',prompt_versions_json) else '{}'::jsonb end as value from eval_target_attributions where project_id=$1 and run_id=$2`,
            [options.projectId, id]
          )
        ).rows
        const savedByTarget = new Map<string, EvalAttribution[]>()
        for (const row of saved) {
          const values = savedByTarget.get(row.targetId) ?? []
          values.push(row.value)
          savedByTarget.set(row.targetId, values)
        }
        const frozen = targets.map((t) =>
          prepareFrozenTarget(t.id, t.traceId, t.snapshot)
        )
        const refs = new Map<string, GroupReference>()
        for (const target of frozen) {
          const persisted = savedByTarget.get(target.id)
          if (persisted) {
            const values = validatedAttributions(persisted)
            if (target.saved && !sameAttributions(values, target.saved))
              throw new BackfillSkip("conflicting_saved_attribution")
            target.saved = values
          } else if (run.groups_resolved_at && !target.saved)
            throw new BackfillSkip("resolved_run_missing_attribution")
          if (!target.saved)
            for (const [key, ref] of target.missingGroups) refs.set(key, ref)
        }
        const labels = await immutableGroups(client, options.projectId, [
          ...refs.values(),
        ])
        const plans = frozen.map((target) => ({
          targetId: target.id,
          attributions: resolveFrozenTarget(target, labels),
        }))
        const expectedGroups = plans.flatMap((p) =>
          p.attributions.flatMap((a) => (a.group ? [a.group] : []))
        )
        const groupKeys = new Set(expectedGroups.map(evalGroupKey))
        const oldGroups = (
          await client.query<InvocationGroup>(
            `select group_type as type,group_name as name,group_version as version from eval_run_groups where project_id=$1 and run_id=$2`,
            [options.projectId, id]
          )
        ).rows
        if (oldGroups.some((g) => !groupKeys.has(evalGroupKey(g))))
          throw new BackfillSkip("conflicting_saved_run_groups")
        const newTargets = plans.filter((p) => !savedByTarget.has(p.targetId))
        const snapshots = plans.filter(
          (_, i) => frozen[i].snapshot.attributions === undefined
        )
        const snapshotIds = new Set(snapshots.map((s) => s.targetId))
        const missingGroups =
          groupKeys.size !== new Set(oldGroups.map(evalGroupKey)).size
        const changed =
          newTargets.length ||
          snapshots.length ||
          links.length ||
          missingGroups ||
          !run.groups_resolved_at
        if (changed && options.apply) {
          const resolvedAt = run.groups_resolved_at ?? new Date().toISOString()
          await audit(backup, {
            type: "prepared",
            batchId,
            projectId: options.projectId,
            runId: id,
            before: {
              groupsResolvedAt: run.groups_resolved_at,
              groups: oldGroups,
              snapshots: targets
                .filter((t) => snapshotIds.has(t.id))
                .map((t) => ({ id: t.id, snapshot: t.snapshot })),
            },
            after: { groupsResolvedAt: resolvedAt },
            addedTargets: newTargets.map((t) => t.targetId),
            linkedResults: links,
            attributions: plans,
          })
          const db = registerTracerProjectId(
            drizzle({ client, schema }),
            options.projectId
          )
          await saveEvalAttributions(db, id, newTargets)
          await saveEvalRunGroups(db, id, expectedGroups)
          for (let i = 0; i < snapshots.length; i += 200)
            await client.query(
              `update eval_run_targets t set snapshot_json=jsonb_set(t.snapshot_json::jsonb,'{attributions}',x.attributions)::text
            from jsonb_to_recordset($3::jsonb) as x("targetId" text,attributions jsonb)
            where t.project_id=$1 and t.run_id=$2 and t.id=x."targetId"`,
              [
                options.projectId,
                id,
                JSON.stringify(snapshots.slice(i, i + 200)),
              ]
            )
          for (let i = 0; i < links.length; i += 1000)
            await db.execute(sql`update eval_results r set target_id=x."targetId"
            from jsonb_to_recordset(${JSON.stringify(links.slice(i, i + 1000))}::jsonb) as x(id text,"targetId" text)
            where r.project_id=${options.projectId} and r.run_id=${id} and r.id=x.id and r.target_id is null`)
          await client.query(
            "update eval_runs set groups_resolved_at=coalesce(groups_resolved_at,$3) where project_id=$1 and id=$2",
            [options.projectId, id, resolvedAt]
          )
        }
        await client.query("COMMIT")
        if (changed) {
          report.changed++
          report.targets += newTargets.length
          report.resultsLinked += links.length
        }
        await audit(backup, {
          type: "committed",
          batchId,
          runId: id,
          changed: !!changed,
          afterRun: id,
        })
      } catch (error) {
        await client.query("ROLLBACK")
        const failure = error as { code?: string; cause?: { code?: string } }
        const code = failure.code ?? failure.cause?.code
        if (
          !(error instanceof BackfillSkip) &&
          code !== "55P03" &&
          code !== "40001"
        )
          throw new BackfillRunError(
            `Stopped while processing run ${id}. Inspect its backup record and rerun the window with a new backup path.`,
            { cause: error }
          )
        const reason = error instanceof BackfillSkip ? error.reason : "busy_run"
        report.skipped.push({ runId: id, reason })
        await audit(backup, {
          type: "skipped",
          batchId,
          runId: id,
          reason,
          afterRun: id,
        })
      }
      report.scanned++
      report.lastProcessedRun = id
    }
    if (!report.interrupted && candidates.rows.length > limit)
      report.nextCursor = report.lastProcessedRun
    await audit(backup, { type: "summary", ...report })
    return report
  } finally {
    try {
      if (locked && client)
        await client.query(
          "select pg_advisory_unlock(hashtext('datool-eval-attribution-backfill'),hashtext($1))",
          [options.projectId]
        )
    } finally {
      client?.release()
      await pool.end()
      await backup?.close()
    }
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      project: { type: "string" },
      before: { type: "string" },
      after: { type: "string" },
      "after-run": { type: "string" },
      limit: { type: "string" },
      apply: { type: "boolean", default: false },
      backup: { type: "string" },
      help: { type: "boolean" },
    },
  })
  if (values.help)
    console.log(
      "DATABASE_URL=... bun run scripts/backfill-eval-attribution.ts --project <exact-project-id> --before <ISO-date> [--after <ISO-date>] [--limit 100] [--after-run <cursor>] [--apply --backup /durable/path/new-backup.jsonl]\nDry-run by default. Install migrations 0034, 0035 and 0045 first. No scorers or application calls execute. Skipped runs need review; retry them without --after-run after resolving the cause."
    )
  else {
    const stop = new AbortController()
    const onStop = () => stop.abort()
    process.once("SIGINT", onStop)
    process.once("SIGTERM", onStop)
    try {
      const report = await runEvalAttributionBackfill({
        projectId: values.project ?? "",
        before: values.before ?? "",
        after: values.after,
        afterRun: values["after-run"],
        limit: values.limit === undefined ? undefined : Number(values.limit),
        apply: values.apply,
        backup: values.backup,
        signal: stop.signal,
      })
      console.log(JSON.stringify(report, null, 2))
      if (report.interrupted) process.exitCode = 130
      else if (report.skipped.length) process.exitCode = 2
    } catch (error) {
      // Database error details may contain frozen inputs or credentials. Keep the CLI output bounded.
      console.error(
        "Backfill stopped. Previously committed runs are retained; inspect the backup and rerun the same window with a new backup path."
      )
      console.error(
        error instanceof BackfillInputError || error instanceof BackfillRunError
          ? error.message
          : error instanceof BackfillSkip
            ? error.reason
            : "Check options, migration prerequisites, connectivity and database logs."
      )
      process.exitCode = 1
    } finally {
      process.removeListener("SIGINT", onStop)
      process.removeListener("SIGTERM", onStop)
    }
  }
}
