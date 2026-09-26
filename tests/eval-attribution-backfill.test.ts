import { expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Pool } from "pg"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"
import {
  createTracerDatabase,
  closeTracerDatabase,
} from "../src/server/tracer/db"
import { TracerService } from "../src/server/tracer/service"
import { runTracerEffect as run } from "../src/server/tracer/effect"
import { defaultScorer } from "../src/lib/tracer/scorers"
import { runEvalAttributionBackfill } from "../scripts/backfill-eval-attribution"
import { captureSpanEvidence } from "../src/server/tracer/span-evidence"
import { executeSemanticBatch } from "../src/server/semantic/executor"
import { semanticCatalog } from "../src/server/metrics/registry"
import { createSemanticSnapshotRunner } from "../src/server/semantic/snapshot"
import type { TraceForEvaluation } from "../src/lib/tracer/contracts"

async function fixture() {
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const db = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
    schema: target.schema,
  })
  const pool = new Pool({ connectionString: target.databaseUrl })
  const dir = await mkdtemp(join(tmpdir(), "datool-eval-backfill-"))
  const service = new TracerService(db)
  const scorer = await run(
    service.scorers.save({
      ...defaultScorer,
      name: "Quality",
      slug: "quality",
      type: "javascript",
      code: "function evaluate({trace}) { return {score:trace.output.score}; }",
    })
  )
  const version = (await run(service.getEvaluator(scorer.id))).activeVersion.id
  const time = new Date(Date.now() - 60000).toISOString()
  const options = {
    projectId: target.projectId,
    before: new Date().toISOString(),
  }
  async function evidence(
    name: string,
    model: string
  ): Promise<TraceForEvaluation> {
    const trace = await run(
      service.createTrace({
        id: name,
        name,
        operation: "workflow",
        group: { type: "workflow", name, version: "1" },
        status: "completed",
        startedAt: time,
        endedAt: time,
        output: { score: 0.75 },
      })
    )
    await run(
      service.createSpan(trace.id, {
        id: `${name}-agent`,
        name: "Agent",
        kind: "agent",
        group: { type: "agent", name: `${name} agent` },
        status: "completed",
        startedAt: time,
        endedAt: time,
        output: { score: 0.75 },
      })
    )
    await run(
      service.createSpan(trace.id, {
        id: `${name}-llm`,
        parentId: `${name}-agent`,
        name: "Generate",
        kind: "llm",
        attributes: { model },
        status: "completed",
        startedAt: time,
        endedAt: time,
      })
    )
    return await run(service.getTrace(trace.id))
  }
  async function legacy(
    id: string,
    traces: TraceForEvaluation[],
    explicit = true
  ) {
    await pool.query(
      "insert into eval_runs(id,project_id,name,status,created_at,completed_at) values($1,$2,$1,'completed',$3,$3)",
      [id, target.projectId, time]
    )
    await pool.query(
      "insert into eval_run_evaluators(id,project_id,run_id,evaluator_id,evaluator_version_id) values($1,$2,$3,$4,$5)",
      [`ere-${id}`, target.projectId, id, scorer.id, version]
    )
    for (const [ordinal, source] of traces.entries()) {
      const trace = structuredClone(source)
      // Before 0034 scorerEvidence dropped root groups; old span snapshots can omit them too.
      delete trace.group
      for (const span of trace.spans) delete span.group
      const targetId = `${id}-target-${ordinal}`
      const snapshot = JSON.stringify({ targetId, trace, datasetItem: null })
      await pool.query(
        "insert into eval_run_targets(id,project_id,run_id,trace_id,ordinal,snapshot_json,created_at) values($1,$2,$3,$4,$5,$6,$7)",
        [targetId, target.projectId, id, trace.id, ordinal, snapshot, time]
      )
      await pool.query(
        `insert into eval_results(id,project_id,run_id,trace_id,evaluator_id,evaluator_version_id,score,status,metadata_json,created_at,completed_at)
        values($1,$2,$3,$4,$5,$6,0.75,'completed',$7,$8,$8)`,
        [
          `result-${targetId}`,
          target.projectId,
          id,
          trace.id,
          scorer.id,
          version,
          JSON.stringify(explicit ? { evalTargetId: targetId } : {}),
          time,
        ]
      )
      await pool.query(
        "insert into scores(id,project_id,trace_id,eval_result_id,evaluator_id,name,value,status,created_at) values($1,$2,$3,$4,$5,'score',0.75,'ok',$6)",
        [
          `score-${targetId}`,
          target.projectId,
          trace.id,
          `result-${targetId}`,
          scorer.id,
          time,
        ]
      )
    }
  }
  const backfill = (
    args: Partial<Parameters<typeof runEvalAttributionBackfill>[0]> = {}
  ) => runEvalAttributionBackfill({ ...options, ...args }, target.databaseUrl)
  const state = async () => {
    const result: Record<string, unknown> = {}
    for (const table of [
      "eval_runs",
      "eval_run_targets",
      "eval_run_groups",
      "eval_target_attributions",
      "eval_results",
      "scores",
      "traces",
      "spans",
    ])
      result[table] = (
        await pool.query(`select * from ${table} order by id`)
      ).rows
    return result
  }
  return {
    target,
    db,
    pool,
    dir,
    service,
    scorer,
    time,
    options,
    evidence,
    legacy,
    backfill,
    state,
    async close() {
      await pool.end()
      await closeTracerDatabase(db)
      await target.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test("dry-run, apply, pagination, frozen models, selected spans, re-score and idempotent reruns", async () => {
  const f = await fixture()
  try {
    const a = await f.evidence("Answer", "frozen-alpha")
    const b = await f.evidence("Extract", "frozen-beta")
    await f.legacy("a-mixed", [a, b])
    const selected = await captureSpanEvidence(f.db, a.id, "Answer-agent")
    await f.legacy("b-selected", [selected], false)
    await f.pool.query(
      "update spans set attributes_json=attributes_json || '{\"model\":\"changed-live-model\"}'::jsonb where kind='llm'"
    )
    const before = await f.state()
    const dry = await f.backfill({ limit: 1 })
    expect(dry).toMatchObject({
      mode: "dry-run",
      scanned: 1,
      changed: 1,
      targets: 2,
      resultsLinked: 2,
      nextCursor: "a-mixed",
      skipped: [],
    })
    expect(await f.state()).toEqual(before)
    const backup = join(f.dir, "first.jsonl")
    const first = await f.backfill({ apply: true, backup, limit: 1 })
    expect(first.nextCursor).toBe("a-mixed")
    const second = await f.backfill({
      apply: true,
      backup: join(f.dir, "second.jsonl"),
      afterRun: first.nextCursor!,
    })
    expect(second).toMatchObject({
      changed: 1,
      targets: 1,
      resultsLinked: 1,
      nextCursor: null,
      skipped: [],
    })
    expect((await stat(backup)).mode & 0o777).toBe(0o600)
    const records = (await readFile(backup, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(records.map((r) => r.type)).toEqual([
      "batch",
      "prepared",
      "committed",
      "summary",
    ])
    expect(records[1].before.snapshots).toHaveLength(2)
    const attrs = (
      await f.pool.query(
        "select run_id,group_type,group_name,models_json from eval_target_attributions order by run_id,group_type,group_name"
      )
    ).rows
    expect(attrs).toHaveLength(5)
    expect(attrs.map((a) => a.models_json)).toEqual([
      ["frozen-alpha"],
      ["frozen-beta"],
      ["frozen-alpha"],
      ["frozen-beta"],
      ["frozen-alpha"],
    ])
    expect(
      attrs.filter((a) => a.run_id === "b-selected").map((a) => a.group_name)
    ).toEqual(["Answer agent"])
    const after = await f.state()
    expect(after.traces).toEqual(before.traces)
    expect(after.spans).toEqual(before.spans)
    expect(after.scores).toEqual(before.scores)
    for (const old of before.eval_run_targets as {
      id: string
      snapshot_json: string
    }[]) {
      const row = (after.eval_run_targets as (typeof old)[]).find(
        (t) => t.id === old.id
      )!
      const { attributions, ...snapshot } = JSON.parse(row.snapshot_json)
      expect(attributions.length > 0).toBe(true)
      expect(snapshot).toEqual(JSON.parse(old.snapshot_json))
    }
    expect(
      await f.backfill({ apply: true, backup: join(f.dir, "noop.jsonl") })
    ).toMatchObject({ changed: 0, scanned: 0, nextCursor: null })
    expect(await f.state()).toEqual(after)
    const rescored = await run(
      f.service.createEvalRun({
        sourceRunId: "a-mixed",
        evaluatorIds: [f.scorer.id],
      })
    )
    expect(rescored.groups?.map((g) => g.name).sort()).toEqual([
      "Answer",
      "Answer agent",
      "Extract",
      "Extract agent",
    ])
    expect(rescored.results.every((r) => r.score === 0.75)).toBe(true)
    const query = await executeSemanticBatch(
      {
        queries: [
          {
            measures: ["evalQuality.scoredCount", "evalQuality.meanScore"],
            dimensions: ["evalQuality.model"],
            filters: [],
            timeDimensions: [
              {
                dimension: "evalQuality.completedAt",
                dateRange: [
                  new Date(Date.parse(f.time) - 1000).toISOString(),
                  new Date(Date.now() + 1000).toISOString(),
                ],
              },
            ],
            order: [["evalQuality.model", "asc"]],
            limit: 100,
          },
        ],
      },
      {
        catalog: semanticCatalog,
        requestId: "backfill-test",
        snapshotRunner: createSemanticSnapshotRunner(f.db),
      }
    )
    expect(
      query[0].data.map((r) => [
        r["evalQuality.model"],
        r["evalQuality.scoredCount"],
        r["evalQuality.meanScore"],
      ])
    ).toEqual([
      ["frozen-alpha", 3, 0.75],
      ["frozen-beta", 2, 0.75],
    ])
  } finally {
    await f.close()
  }
}, 60000)

test("unsafe legacy runs are skipped atomically and existing saved attribution is preserved", async () => {
  const f = await fixture()
  try {
    const a = await f.evidence("Answer", "frozen")
    await f.legacy("a-ambiguous", [a, a], false)
    await f.legacy("b-missing", [a])
    await f.pool.query(
      "update eval_run_targets set snapshot_json=null where run_id='b-missing'"
    )
    await f.legacy("c-invalid-reference", [a])
    await f.pool.query(
      "update eval_results set metadata_json='{\"evalTargetId\":\"different-run-target\"}' where run_id='c-invalid-reference'"
    )
    await f.legacy("d-running", [a])
    await f.pool.query(
      "update eval_runs set status='running' where id='d-running'"
    )
    await f.legacy("e-leased", [a])
    await f.pool.query(
      "insert into eval_run_lease(run_id,owner,expires_at) values('e-leased','live-worker',now()+interval '1 minute')"
    )
    await f.legacy("f-invalid-json", [a])
    await f.pool.query(
      "update eval_run_targets set snapshot_json='bad-json' where run_id='f-invalid-json'"
    )
    await f.legacy("g-orphan-span", [
      { ...a, spans: a.spans.filter((s) => s.id !== "Answer-agent") },
    ])
    await f.legacy("h-conflicting-group", [a])
    await f.pool.query(
      "insert into eval_run_groups(id,project_id,run_id,group_type,group_name) values('conflicting-group',$1,'h-conflicting-group','workflow','Not in frozen evidence')",
      [f.target.projectId]
    )
    await f.legacy("i-too-many-targets", [a])
    await f.pool.query(
      "insert into eval_run_targets(id,project_id,run_id,trace_id,ordinal,created_at) select 'oversized-' || i,$1,'i-too-many-targets',$2,i,$3 from generate_series(1,10000) i",
      [f.target.projectId, a.id, f.time]
    )
    const before = await f.state()
    const report = await f.backfill({
      apply: true,
      backup: join(f.dir, "skips.jsonl"),
    })
    expect(report.changed).toBe(0)
    expect(report.skipped.map((s) => s.reason)).toEqual([
      "ambiguous_result_target",
      "missing_frozen_snapshot",
      "missing_result_target",
      "run_not_terminal",
      "active_execution_lease",
      "invalid_frozen_snapshot",
      "incomplete_span_ancestry",
      "conflicting_saved_run_groups",
      "run_exceeds_backfill_limit",
    ])
    expect(await f.state()).toEqual(before)
    // A 0034 run already has frozen attribution; only the new 0035 result links are missing.
    const existing = await run(
      f.service.createEvalRun({ traceIds: [a.id], evaluatorIds: [f.scorer.id] })
    )
    await f.pool.query(
      "update eval_results set target_id=null where run_id=$1",
      [existing.id]
    )
    const saved = (
      await f.pool.query(
        "select * from eval_target_attributions where run_id=$1 order by id",
        [existing.id]
      )
    ).rows
    const snapshot = (
      await f.pool.query(
        "select snapshot_json from eval_run_targets where run_id=$1",
        [existing.id]
      )
    ).rows
    const repaired = await f.backfill({
      apply: true,
      backup: join(f.dir, "links.jsonl"),
      before: new Date().toISOString(),
    })
    expect(repaired).toMatchObject({ changed: 1, targets: 0, resultsLinked: 1 })
    expect(
      (
        await f.pool.query(
          "select * from eval_target_attributions where run_id=$1 order by id",
          [existing.id]
        )
      ).rows
    ).toEqual(saved)
    expect(
      (
        await f.pool.query(
          "select snapshot_json from eval_run_targets where run_id=$1",
          [existing.id]
        )
      ).rows
    ).toEqual(snapshot)
    await f.pool.query(
      "update eval_run_targets set snapshot_json=jsonb_set(snapshot_json::jsonb,'{attributions,0,models}','[\"tampered\"]'::jsonb)::text where run_id=$1",
      [existing.id]
    )
    await f.pool.query(
      "update eval_runs set groups_resolved_at=null where id=$1",
      [existing.id]
    )
    const conflicted = await f.state()
    const conflictReport = await f.backfill({
      apply: true,
      backup: join(f.dir, "conflict.jsonl"),
      before: new Date().toISOString(),
    })
    expect(conflictReport.changed).toBe(0)
    expect(
      conflictReport.skipped.find((row) => row.runId === existing.id)?.reason
    ).toBe("conflicting_saved_attribution")
    expect(await f.state()).toEqual(conflicted)
  } finally {
    await f.close()
  }
}, 60000)

test("rollback, durable backups, interrupted batches and concurrent execution locks", async () => {
  const f = await fixture()
  const locker = await f.pool.connect()
  try {
    const a = await f.evidence("Answer", "frozen")
    await f.legacy("a-success", [a])
    await f.legacy("b-failure", [a])
    const stopped = new AbortController()
    stopped.abort()
    expect(await f.backfill({ signal: stopped.signal })).toMatchObject({
      interrupted: true,
      scanned: 0,
      changed: 0,
    })
    await locker.query(
      "select pg_advisory_lock(hashtext('datool-eval-attribution-backfill'),hashtext($1))",
      [f.target.projectId]
    )
    let locked = false
    try {
      await f.backfill({ apply: true, backup: join(f.dir, "locked.jsonl") })
    } catch (error) {
      locked = (error as Error).message.includes("already running")
    }
    expect(locked).toBe(true)
    await locker.query(
      "select pg_advisory_unlock(hashtext('datool-eval-attribution-backfill'),hashtext($1))",
      [f.target.projectId]
    )
    await locker.query("begin")
    await locker.query(
      "select 1 from eval_runs where id='a-success' for update"
    )
    expect(
      (
        await f.backfill({
          apply: true,
          backup: join(f.dir, "busy.jsonl"),
          limit: 1,
        })
      ).skipped
    ).toEqual([{ runId: "a-success", reason: "busy_run" }])
    await locker.query("rollback")
    await f.pool
      .query(`create function reject_backfill() returns trigger language plpgsql as $$ begin if new.run_id='b-failure' then raise exception 'injected failure'; end if; return new; end $$;
      create trigger reject_backfill before update of target_id on eval_results for each row execute function reject_backfill()`)
    const backup = join(f.dir, "failure.jsonl")
    let failed = false
    try {
      await f.backfill({ apply: true, backup })
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
    expect(
      (
        await f.pool.query(
          "select id,groups_resolved_at is not null as resolved from eval_runs order by id"
        )
      ).rows
    ).toEqual([
      { id: "a-success", resolved: true },
      { id: "b-failure", resolved: false },
    ])
    expect(
      (
        await f.pool.query(
          "select count(*)::int n from eval_target_attributions where run_id='b-failure'"
        )
      ).rows[0].n
    ).toBe(0)
    expect(
      (
        await f.pool.query(
          "select target_id from eval_results where run_id='b-failure'"
        )
      ).rows[0].target_id
    ).toBeNull()
    expect(
      JSON.parse(
        (
          await f.pool.query(
            "select snapshot_json from eval_run_targets where run_id='b-failure'"
          )
        ).rows[0].snapshot_json
      ).attributions
    ).toBeUndefined()
    const audit = (await readFile(backup, "utf8"))
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s))
    expect(audit.filter((r) => r.type === "prepared")).toHaveLength(2)
    expect(
      audit.filter((r) => r.type === "committed").map((r) => r.runId)
    ).toEqual(["a-success"])
    await f.pool.query("drop trigger reject_backfill on eval_results")
    const resumed = await f.backfill({
      apply: true,
      backup: join(f.dir, "resumed.jsonl"),
    })
    expect(resumed).toMatchObject({ scanned: 1, changed: 1, resultsLinked: 1 })
    let exclusive = false
    try {
      await f.backfill({ apply: true, backup })
    } catch (error) {
      exclusive = (error as { code?: string }).code === "EEXIST"
    }
    expect(exclusive).toBe(true)
  } finally {
    await locker.query("rollback")
    locker.release()
    await f.close()
  }
}, 60000)

test("operator CLI enforces dry-run/apply, project and cutoff scope, and migration prerequisites", async () => {
  const f = await fixture()
  try {
    const a = await f.evidence("Answer", "frozen")
    await f.legacy("a-cli", [a])
    await f.pool.query(
      "insert into project(id,organization_id,name,slug) values('other-project',$1,'Other','other-project')",
      [f.target.organizationId]
    )
    await f.pool.query(
      "insert into eval_runs(id,project_id,status,created_at) values('other-run','other-project','completed',$1)",
      [f.time]
    )
    await f.pool.query(
      "insert into eval_runs(id,project_id,status,created_at) values('future-run',$1,'completed',$2)",
      [f.target.projectId, new Date(Date.now() + 86400000).toISOString()]
    )
    const cli = (extra: string[]) =>
      new Promise<{ stdout: string; stderr: string; exitCode: number }>(
        (resolve) => {
          execFile(
            process.execPath,
            [
              "--no-env-file",
              "scripts/backfill-eval-attribution.ts",
              "--project",
              f.target.projectId,
              "--before",
              f.options.before,
              ...extra,
            ],
            {
              env: { ...process.env, DATABASE_URL: f.target.databaseUrl },
              maxBuffer: 2 * 1024 * 1024,
            },
            (error, stdout, stderr) =>
              resolve({
                stdout,
                stderr,
                exitCode: error
                  ? typeof error.code === "number"
                    ? error.code
                    : 1
                  : 0,
              })
          )
        }
      )
    const dry = await cli([])
    expect(dry.exitCode).toBe(0)
    expect(JSON.parse(dry.stdout)).toMatchObject({
      mode: "dry-run",
      scanned: 1,
      changed: 1,
    })
    expect(
      (await f.pool.query("select target_id from eval_results")).rows[0]
        .target_id
    ).toBeNull()
    const missingBackup = await cli(["--apply"])
    expect(missingBackup.exitCode).toBe(1)
    expect(missingBackup.stderr).toContain("requires a new --backup")
    const applied = await cli(["--apply", "--backup", join(f.dir, "cli.jsonl")])
    expect(applied.exitCode).toBe(0)
    expect(JSON.parse(applied.stdout)).toMatchObject({
      mode: "apply",
      changed: 1,
      resultsLinked: 1,
      skipped: [],
    })
    expect(
      (
        await f.pool.query(
          "select id from eval_runs where groups_resolved_at is null order by id"
        )
      ).rows.map((r) => r.id)
    ).toEqual(["future-run", "other-run"])
    const noop = await cli([])
    expect(JSON.parse(noop.stdout)).toMatchObject({ scanned: 0, changed: 0 })
    await f.pool.query("alter table eval_results drop column target_id cascade")
    expect(
      (await cli(["--apply", "--backup", join(f.dir, "no-migration.jsonl")]))
        .exitCode
    ).toBe(1)
  } finally {
    await f.close()
  }
}, 60000)
