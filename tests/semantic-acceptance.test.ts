import { Effect } from "effect"
import { afterEach, describe, expect, test } from "bun:test"
import { Pool, type QueryResultRow } from "pg"

import type { SemanticCatalog } from "@/src/lib/semantic/catalog"
import { semanticCatalog } from "@/src/server/metrics/registry"
import {
  SemanticExecutionError,
  createSemanticQueryService,
  createSemanticSnapshotRunner,
  type SemanticQueryService,
  type SemanticSnapshotRunner,
} from "@/src/server/semantic"
import {
  closeTracerDatabase,
  createTracerDatabase,
  getTracerProjectId,
  type TracerDatabase,
} from "@/src/server/tracer/db"
import { traces } from "@/src/server/tracer/schema"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
  type IsolatedPostgres,
} from "@/tests/helpers/postgres"

type Fixture = Readonly<{
  catalog: SemanticCatalog
  database: TracerDatabase
  service: SemanticQueryService
  target: IsolatedPostgres
}>

type SqlValue = string | number | boolean | null
type DatabaseClient = {
  query: (
    sql: string,
    values: readonly SqlValue[]
  ) => Promise<{ rows: QueryResultRow[] }>
}

const FIXTURE_NOW = new Date("2026-09-07T12:00:00.000Z")

/**
 * This suite deliberately does not use TracerService, demo generation, or an
 * evaluator runner to create facts. The rows below are the independent PostgreSQL
 * oracle fixture for semantic query behavior.
 */
const fixtures = new Set<IsolatedPostgres>()
const databases = new Set<TracerDatabase>()

afterEach(async () => {
  await Promise.all(
    [...databases].map((database) => closeTracerDatabase(database))
  )
  databases.clear()
  await Promise.all([...fixtures].map((fixture) => fixture.close()))
  fixtures.clear()
})

async function createFixture(): Promise<Fixture> {
  const target = await createIsolatedPostgres()
  fixtures.add(target)
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const database = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
    schema: target.schema,
  })
  databases.add(database)
  await seedFixture(database)
  const catalog = semanticCatalog
  const service = createSemanticQueryService({
    catalog,
    database,
    now: () => new Date(FIXTURE_NOW),
    requestId: () => "sem_acceptance",
  })
  return { catalog, database, service, target }
}

async function raw(
  database: TracerDatabase,
  sql: string,
  args: readonly SqlValue[] = []
) {
  const projectId = getTracerProjectId(database)
  const statement = sql
    .replace(
      /INSERT INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)/,
      (_, table, columns, values) =>
        `INSERT INTO ${table} (${columns}, project_id) VALUES (${values}, $${args.length + 1})`
    )
    .replace(/\bAS ([a-z][A-Za-z]*[A-Z][A-Za-z]*)\b/g, 'AS "$1"')
  const values = /^INSERT INTO /i.test(sql) ? [...args, projectId] : [...args]
  return (database as unknown as { $client: DatabaseClient }).$client.query(
    statement,
    values
  )
}

async function rawRows(
  database: TracerDatabase,
  sql: string,
  args: readonly SqlValue[] = []
) {
  return (await raw(database, sql, args)).rows.map((row: QueryResultRow) => ({
    ...row,
  }))
}

function numberAt(row: Record<string, unknown>, key: string) {
  const value = row[key]
  expect(value).not.toBeNull()
  expect(value).not.toBeUndefined()
  return Number(value)
}

function traceValues(
  id: string,
  operation: string,
  status: string,
  startedAt: string,
  endedAt: string | null
) {
  return [
    id,
    null,
    id,
    operation,
    null,
    null,
    "{}",
    status,
    startedAt,
    endedAt,
  ] as const
}

async function seedFixture(database: TracerDatabase) {
  const at = "2026-08-31T00:00:00.000Z"
  await raw(
    database,
    "INSERT INTO sessions (id, name, attributes_json, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)",
    ["session_semantic", "Semantic acceptance", "{}", at, at]
  )

  const traceRows = [
    traceValues(
      "tr_boundary_before",
      "qa.boundary",
      "completed",
      "2026-09-01T02:59:59.000Z",
      "2026-09-01T03:00:00.000Z"
    ),
    traceValues(
      "tr_boundary_after",
      "qa.boundary",
      "errored",
      "2026-09-01T03:00:00.000Z",
      "2026-09-01T03:00:02.000Z"
    ),
    traceValues(
      "tr_upper_bound",
      "qa.upper",
      "running",
      "2026-09-02T00:00:00.000Z",
      null
    ),
    traceValues(
      "tr_snapshot_app_before",
      "qa.snapshot.app",
      "completed",
      "2026-09-03T12:00:00.000Z",
      "2026-09-03T12:00:01.000Z"
    ),
    traceValues(
      "tr_snapshot_external_before",
      "qa.snapshot.external",
      "completed",
      "2026-09-03T12:01:00.000Z",
      "2026-09-03T12:01:01.000Z"
    ),
  ]
  for (const values of traceRows) {
    await raw(
      database,
      "INSERT INTO traces (id, session_id, name, operation, input_json, output_json, attributes_json, status, started_at, ended_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
      values
    )
  }

  await raw(
    database,
    "INSERT INTO datasets (id, name, description, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)",
    ["ds_alpha", "Alpha", null, at, at]
  )
  await raw(
    database,
    "INSERT INTO datasets (id, name, description, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)",
    ["ds_beta", "Beta", null, at, at]
  )
  await raw(
    database,
    "INSERT INTO dataset_items (id, dataset_id, input_json, expected_output_json, metadata_json, source_trace_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    ["item_alpha", "ds_alpha", "{}", "{}", "{}", "tr_boundary_after", at, at]
  )
  await raw(
    database,
    "INSERT INTO dataset_items (id, dataset_id, input_json, expected_output_json, metadata_json, source_trace_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    ["item_beta", "ds_beta", "{}", "{}", "{}", "tr_boundary_before", at, at]
  )

  await raw(
    database,
    "INSERT INTO evaluators (id, name, description, active_version_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
    ["ev_quality", "Quality", null, null, at, at]
  )
  await raw(
    database,
    "INSERT INTO evaluator_versions (id, evaluator_id, version, language, code, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [
      "ev_quality_v1",
      "ev_quality",
      1,
      "javascript",
      "function evaluate() {}",
      at,
    ]
  )
  await raw(
    database,
    "INSERT INTO evaluator_versions (id, evaluator_id, version, language, code, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [
      "ev_quality_v2",
      "ev_quality",
      2,
      "javascript",
      "function evaluate() {}",
      at,
    ]
  )
  await raw(
    database,
    "UPDATE evaluators SET active_version_id = $1 WHERE id = $2",
    ["ev_quality_v2", "ev_quality"]
  )
  await raw(
    database,
    "INSERT INTO evaluators (id, name, description, active_version_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
    ["ev_style", "Style", null, null, at, at]
  )
  await raw(
    database,
    "INSERT INTO evaluator_versions (id, evaluator_id, version, language, code, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    ["ev_style_v1", "ev_style", 1, "javascript", "function evaluate() {}", at]
  )
  await raw(
    database,
    "UPDATE evaluators SET active_version_id = $1 WHERE id = $2",
    ["ev_style_v1", "ev_style"]
  )

  const runs = [
    [
      "run_mixed",
      "Mixed dataset and direct target",
      "ds_alpha",
      "completed",
      "2026-09-01T12:00:00.000Z",
    ],
    [
      "run_repeat",
      "Repeat trace target",
      "ds_alpha",
      "completed",
      "2026-09-01T13:00:00.000Z",
    ],
    [
      "run_fanout",
      "Two targets two evaluators",
      "ds_beta",
      "partial",
      "2026-09-01T14:00:00.000Z",
    ],
    [
      "run_recovered",
      "Recovered without results",
      null,
      "failed",
      "2026-09-01T15:00:00.000Z",
    ],
    [
      "run_v2",
      "Current evaluator version",
      "ds_beta",
      "completed",
      "2026-09-01T16:00:00.000Z",
    ],
    [
      "run_invalid",
      "Invalid persisted score",
      null,
      "completed",
      "2026-09-05T12:00:00.000Z",
    ],
  ] as const
  for (const [id, name, datasetId, status, createdAt] of runs) {
    await raw(
      database,
      "INSERT INTO eval_runs (id, name, dataset_id, status, created_at, completed_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, name, datasetId, status, createdAt, createdAt]
    )
  }

  const runEvaluators = [
    ["run_eval_mixed", "run_mixed", "ev_quality", "ev_quality_v1"],
    ["run_eval_repeat", "run_repeat", "ev_quality", "ev_quality_v1"],
    ["run_eval_fanout_quality", "run_fanout", "ev_quality", "ev_quality_v1"],
    ["run_eval_fanout_style", "run_fanout", "ev_style", "ev_style_v1"],
    ["run_eval_v2", "run_v2", "ev_quality", "ev_quality_v2"],
    ["run_eval_invalid", "run_invalid", "ev_quality", "ev_quality_v2"],
  ] as const
  for (const values of runEvaluators) {
    await raw(
      database,
      "INSERT INTO eval_run_evaluators (id, run_id, evaluator_id, evaluator_version_id) VALUES ($1, $2, $3, $4)",
      values
    )
  }

  const targets = [
    ["target_mixed_dataset", "run_mixed", "tr_boundary_after", "item_alpha", 0],
    ["target_mixed_direct", "run_mixed", "tr_boundary_before", null, 1],
    ["target_repeat", "run_repeat", "tr_boundary_after", "item_alpha", 0],
    ["target_fanout_a", "run_fanout", "tr_boundary_after", "item_beta", 0],
    ["target_fanout_b", "run_fanout", "tr_boundary_before", null, 1],
    ["target_v2", "run_v2", "tr_boundary_after", "item_beta", 0],
  ] as const
  for (const [id, runId, traceId, datasetItemId, ordinal] of targets) {
    await raw(
      database,
      "INSERT INTO eval_run_targets (id, run_id, trace_id, dataset_item_id, ordinal, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, runId, traceId, datasetItemId, ordinal, at]
    )
  }

  const results = [
    [
      "result_mixed_pass",
      "run_mixed",
      "tr_boundary_after",
      "item_alpha",
      "ev_quality",
      "ev_quality_v1",
      1,
      true,
      "passed",
    ],
    [
      "result_mixed_fail",
      "run_mixed",
      "tr_boundary_before",
      null,
      "ev_quality",
      "ev_quality_v1",
      0,
      false,
      "failed",
    ],
    [
      "result_repeat",
      "run_repeat",
      "tr_boundary_after",
      "item_alpha",
      "ev_quality",
      "ev_quality_v1",
      0.25,
      false,
      "failed",
    ],
    [
      "result_fanout_pass",
      "run_fanout",
      "tr_boundary_after",
      "item_beta",
      "ev_quality",
      "ev_quality_v1",
      0.75,
      true,
      "passed",
    ],
    [
      "result_fanout_unclassified",
      "run_fanout",
      "tr_boundary_after",
      "item_beta",
      "ev_style",
      "ev_style_v1",
      0.5,
      null,
      "completed",
    ],
    [
      "result_fanout_error",
      "run_fanout",
      "tr_boundary_before",
      null,
      "ev_quality",
      "ev_quality_v1",
      null,
      null,
      "error",
    ],
    [
      "result_fanout_zero",
      "run_fanout",
      "tr_boundary_before",
      null,
      "ev_style",
      "ev_style_v1",
      0,
      false,
      "failed",
    ],
    [
      "result_v2",
      "run_v2",
      "tr_boundary_after",
      "item_beta",
      "ev_quality",
      "ev_quality_v2",
      0.3,
      true,
      "passed",
    ],
  ] as const
  for (const [
    id,
    runId,
    traceId,
    datasetItemId,
    evaluatorId,
    evaluatorVersionId,
    score,
    passed,
    status,
  ] of results) {
    const completedAt = "2026-09-01T17:00:00.000Z"
    await raw(
      database,
      "INSERT INTO eval_results (id, run_id, trace_id, dataset_item_id, evaluator_id, evaluator_version_id, score, passed, status, reasoning, error, metadata_json, created_at, completed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
      [
        id,
        runId,
        traceId,
        datasetItemId,
        evaluatorId,
        evaluatorVersionId,
        score,
        passed,
        status,
        null,
        status === "error" ? "sandbox error" : null,
        "{}",
        completedAt,
        completedAt,
      ]
    )
    await raw(
      database,
      "INSERT INTO scores (id, trace_id, eval_result_id, evaluator_id, name, value, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [
        `score_${id}`,
        traceId,
        id,
        evaluatorId,
        "score",
        score,
        score === null ? "error" : "ok",
        completedAt,
      ]
    )
  }

  const invalidAt = "2026-09-05T12:00:00.000Z"
  await raw(
    database,
    "INSERT INTO eval_results (id, run_id, trace_id, dataset_item_id, evaluator_id, evaluator_version_id, score, passed, status, reasoning, error, metadata_json, created_at, completed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
    [
      "result_invalid_score",
      "run_invalid",
      "tr_boundary_after",
      null,
      "ev_quality",
      "ev_quality_v2",
      1.5,
      null,
      "completed",
      null,
      null,
      "{}",
      invalidAt,
      invalidAt,
    ]
  )
  await raw(
    database,
    "INSERT INTO scores (id, trace_id, eval_result_id, evaluator_id, name, value, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [
      "score_invalid",
      "tr_boundary_after",
      "result_invalid_score",
      "ev_quality",
      "score",
      1.5,
      "ok",
      invalidAt,
    ]
  )
}

function traceQuery(operation: string) {
  return {
    dimensions: [],
    filters: [
      { member: "traces.operation", operator: "equals", values: [operation] },
    ],
    measures: ["traces.count"],
    timeDimensions: [
      {
        dateRange: ["2026-09-03T00:00:00.000Z", "2026-09-04T00:00:00.000Z"],
        dimension: "traces.startedAt",
        granularity: "day",
      },
    ],
    timezone: "UTC",
    total: true,
  }
}

async function runQuery(fixture: Fixture, input: unknown) {
  return Effect.runPromise(fixture.service.query(input))
}

async function capturedError(action: () => Promise<unknown>) {
  try {
    await action()
  } catch (error) {
    return error
  }
  throw new Error("Expected semantic operation to fail.")
}

function deferred<Value>() {
  let reject!: (reason?: unknown) => void
  let resolve!: (value: Value | PromiseLike<Value>) => void
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, reject, resolve }
}

async function resolvesWithin<Value>(
  promise: Promise<Value>,
  timeoutMs = 1_500
): Promise<Value> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(`Operation did not settle within ${timeoutMs}ms.`)
            ),
          timeoutMs
        )
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

describe("semantic acceptance", () => {
  test("uses offset-aware UTC and Sao_Paulo day buckets, excludes the upper bound, and paginates grouped rows", async () => {
    const fixture = await createFixture()

    const rawBoundary = await rawRows(
      fixture.database,
      "SELECT COUNT(*) AS count FROM traces WHERE operation = $1 AND started_at >= $2 AND started_at < $3",
      ["qa.boundary", "2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"]
    )
    expect(numberAt(rawBoundary[0]!, "count")).toBe(2)

    const utc = await runQuery(fixture, {
      dimensions: ["traces.operation"],
      filters: [
        {
          member: "traces.operation",
          operator: "equals",
          values: ["qa.boundary"],
        },
      ],
      measures: ["traces.count"],
      timeDimensions: [
        {
          dateRange: ["2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"],
          dimension: "traces.startedAt",
          granularity: "day",
        },
      ],
      timezone: "UTC",
    })
    expect(utc.data).toEqual([
      {
        "traces.count": 2,
        "traces.operation": "qa.boundary",
        "traces.startedAt": "2026-09-01",
      },
    ])

    const saoPaulo = await runQuery(fixture, {
      dimensions: ["traces.operation"],
      filters: [
        {
          member: "traces.operation",
          operator: "equals",
          values: ["qa.boundary"],
        },
      ],
      measures: ["traces.count"],
      timeDimensions: [
        {
          dateRange: ["2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"],
          dimension: "traces.startedAt",
          granularity: "day",
        },
      ],
      timezone: "America/Sao_Paulo",
    })
    expect(saoPaulo.data).toEqual([
      {
        "traces.count": 1,
        "traces.operation": "qa.boundary",
        "traces.startedAt": "2026-08-31",
      },
      {
        "traces.count": 1,
        "traces.operation": "qa.boundary",
        "traces.startedAt": "2026-09-01",
      },
    ])

    const rawGroups = await rawRows(
      fixture.database,
      "SELECT operation, substr(started_at, 1, 10) AS day, COUNT(*) AS count FROM traces WHERE started_at >= $1 AND started_at < $2 GROUP BY operation, day ORDER BY operation ASC, day ASC",
      ["2026-09-01T00:00:00.000Z", "2026-09-04T00:00:00.000Z"]
    )
    const page = await runQuery(fixture, {
      dimensions: ["traces.operation"],
      limit: 1,
      measures: ["traces.count"],
      offset: 1,
      order: [["traces.operation", "asc"]],
      timeDimensions: [
        {
          dateRange: ["2026-09-01T00:00:00.000Z", "2026-09-04T00:00:00.000Z"],
          dimension: "traces.startedAt",
          granularity: "day",
        },
      ],
      timezone: "UTC",
      total: true,
    })
    expect(page.meta.page.total).toBe(rawGroups.length)
    expect(page.data).toEqual([
      {
        "traces.count": numberAt(rawGroups[1]!, "count"),
        "traces.operation": rawGroups[1]!.operation,
        "traces.startedAt": rawGroups[1]!.day,
      },
    ])
    expect(Object.keys(page.data[0]!).sort()).toEqual([
      "traces.count",
      "traces.operation",
      "traces.startedAt",
    ])
  })

  test("applies an offset-aware candidate range before the fact cap without admitting its upper bound", async () => {
    const fixture = await createFixture()
    const historicalTraces = Array.from({ length: 20_001 }, (_, index) => ({
      attributesJson: "{}",
      endedAt: "2025-01-01T00:00:01.000Z",
      id: `tr_historical_${index}`,
      name: `historical-${index}`,
      operation: "qa.history",
      projectId: fixture.target.projectId,
      startedAt: "2025-01-01T00:00:00.000Z",
      status: "completed",
    }))
    for (let start = 0; start < historicalTraces.length; start += 500) {
      await fixture.database
        .insert(traces)
        .values(historicalTraces.slice(start, start + 500))
    }
    await raw(
      fixture.database,
      "INSERT INTO traces (id, session_id, name, operation, input_json, output_json, attributes_json, status, started_at, ended_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
      traceValues(
        "tr_offset_upper",
        "qa.boundary",
        "completed",
        "2026-09-01T03:00:01.000Z",
        "2026-09-01T03:00:02.000Z"
      )
    )

    const result = await runQuery(fixture, {
      dimensions: ["traces.operation"],
      measures: ["traces.count"],
      timeDimensions: [
        {
          // These instants are 03:00:00Z through 03:00:01Z. The lower
          // boundary includes tr_boundary_after; the upper boundary excludes
          // tr_offset_upper. More than 20k older facts cannot trigger a cap.
          dateRange: [
            "2026-09-01T04:00:00.000+01:00",
            "2026-09-01T04:00:01.000+01:00",
          ],
          dimension: "traces.startedAt",
          granularity: "day",
        },
      ],
      timezone: "UTC",
    })
    expect(result.data).toEqual([
      {
        "traces.count": 1,
        "traces.operation": "qa.boundary",
        "traces.startedAt": "2026-09-01",
      },
    ])
  })

  test("uses independent result and target grains for eval runs without target or evaluator fanout", async () => {
    const fixture = await createFixture()
    const rawAlpha = await rawRows(
      fixture.database,
      `SELECT
        run.status AS status,
        run.dataset_id AS datasetId,
        COUNT(DISTINCT run.id) AS runCount,
        COUNT(DISTINCT result.id) AS resultCount,
        COUNT(DISTINCT target.id) AS targetCount,
        COUNT(DISTINCT target.trace_id) AS uniqueTraceCount
      FROM eval_runs AS run
      LEFT JOIN eval_results AS result ON result.run_id = run.id
      LEFT JOIN eval_run_targets AS target ON target.run_id = run.id
      WHERE run.dataset_id = $1 AND run.status = $2 AND run.created_at >= $3 AND run.created_at < $4
      GROUP BY run.status, run.dataset_id`,
      [
        "ds_alpha",
        "completed",
        "2026-09-01T00:00:00.000Z",
        "2026-09-02T00:00:00.000Z",
      ]
    )
    expect(rawAlpha).toHaveLength(1)
    expect(numberAt(rawAlpha[0]!, "runCount")).toBe(2)
    expect(numberAt(rawAlpha[0]!, "resultCount")).toBe(3)
    expect(numberAt(rawAlpha[0]!, "targetCount")).toBe(3)
    // The same trace is selected by two runs. This must be a group-level set,
    // not the sum of each run's per-run distinct count.
    expect(numberAt(rawAlpha[0]!, "uniqueTraceCount")).toBe(2)

    const alpha = await runQuery(fixture, {
      dimensions: ["evalRuns.status", "evalRuns.datasetId"],
      filters: [
        {
          member: "evalRuns.datasetId",
          operator: "equals",
          values: ["ds_alpha"],
        },
        {
          member: "evalRuns.status",
          operator: "equals",
          values: ["completed"],
        },
      ],
      measures: [
        "evalRuns.count",
        "evalRuns.completedCount",
        "evalRuns.resultCount",
        "evalRuns.selectedTargetCount",
        "evalRuns.selectedUniqueTraceCount",
      ],
      timeDimensions: [
        {
          dateRange: ["2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"],
          dimension: "evalRuns.createdAt",
          granularity: "day",
        },
      ],
      timezone: "UTC",
    })
    expect(alpha.data).toEqual([
      {
        "evalRuns.completedCount": numberAt(rawAlpha[0]!, "runCount"),
        "evalRuns.count": numberAt(rawAlpha[0]!, "runCount"),
        "evalRuns.createdAt": "2026-09-01",
        "evalRuns.datasetId": rawAlpha[0]!.datasetId,
        "evalRuns.resultCount": numberAt(rawAlpha[0]!, "resultCount"),
        "evalRuns.selectedTargetCount": numberAt(rawAlpha[0]!, "targetCount"),
        "evalRuns.selectedUniqueTraceCount": numberAt(
          rawAlpha[0]!,
          "uniqueTraceCount"
        ),
        "evalRuns.status": rawAlpha[0]!.status,
      },
    ])

    const fanout = await runQuery(fixture, {
      dimensions: ["evalRuns.status"],
      filters: [
        { member: "evalRuns.status", operator: "equals", values: ["partial"] },
      ],
      measures: [
        "evalRuns.count",
        "evalRuns.resultCount",
        "evalRuns.selectedTargetCount",
        "evalRuns.selectedUniqueTraceCount",
      ],
      timeDimensions: [
        {
          dateRange: ["2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"],
          dimension: "evalRuns.createdAt",
          granularity: "day",
        },
      ],
      timezone: "UTC",
    })
    expect(fanout.data[0]).toMatchObject({
      "evalRuns.count": 1,
      "evalRuns.resultCount": 4,
      "evalRuns.selectedTargetCount": 2,
      "evalRuns.selectedUniqueTraceCount": 2,
      "evalRuns.status": "partial",
    })
  })

  test("keeps score zero, null, errors, result-level dataset membership, and evaluator history distinct", async () => {
    const fixture = await createFixture()
    const scoreMeasures = [
      "scores.executionCount",
      "scores.scoredCount",
      "scores.meanScore",
      "scores.explicitPassCount",
      "scores.explicitFailCount",
      "scores.explicitPassRate",
      "scores.errorCount",
      "scores.failedCheckCount",
      "scores.uniqueTraceCount",
    ]
    const rawAll = await rawRows(
      fixture.database,
      `SELECT
        COUNT(result.id) AS executionCount,
        SUM(CASE WHEN score.status = 'ok' AND score.value IS NOT NULL AND score.value >= 0 AND score.value <= 1 THEN 1 ELSE 0 END) AS scoredCount,
        AVG(CASE WHEN score.status = 'ok' AND score.value IS NOT NULL AND score.value >= 0 AND score.value <= 1 THEN score.value END) AS meanScore,
        SUM(CASE WHEN result.passed IS TRUE THEN 1 ELSE 0 END) AS explicitPassCount,
        SUM(CASE WHEN result.passed IS FALSE THEN 1 ELSE 0 END) AS explicitFailCount,
        SUM(CASE WHEN result.status = 'error' THEN 1 ELSE 0 END) AS errorCount,
        SUM(CASE WHEN result.status = 'failed' THEN 1 ELSE 0 END) AS failedCheckCount,
        COUNT(DISTINCT result.trace_id) AS uniqueTraceCount
      FROM eval_results AS result
      LEFT JOIN scores AS score ON score.eval_result_id = result.id AND score.name = 'score'
      WHERE COALESCE(result.completed_at, result.created_at) >= $1
        AND COALESCE(result.completed_at, result.created_at) < $2`,
      ["2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"]
    )
    expect(rawAll).toHaveLength(1)
    expect(numberAt(rawAll[0]!, "executionCount")).toBe(8)
    expect(numberAt(rawAll[0]!, "scoredCount")).toBe(7)
    expect(numberAt(rawAll[0]!, "errorCount")).toBe(1)
    expect(numberAt(rawAll[0]!, "failedCheckCount")).toBe(3)

    const allScores = await runQuery(fixture, {
      measures: scoreMeasures,
      timeDimensions: [
        {
          dateRange: ["2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"],
          dimension: "scores.completedAt",
          granularity: "day",
        },
      ],
      timezone: "UTC",
    })
    expect(allScores.data).toHaveLength(1)
    const aggregate = allScores.data[0]!
    expect(aggregate["scores.completedAt"]).toBe("2026-09-01")
    expect(aggregate["scores.executionCount"]).toBe(
      numberAt(rawAll[0]!, "executionCount")
    )
    // score = 0 remains an eligible observation rather than becoming null.
    expect(aggregate["scores.scoredCount"]).toBe(
      numberAt(rawAll[0]!, "scoredCount")
    )
    expect(
      Math.abs(
        Number(aggregate["scores.meanScore"]) -
          numberAt(rawAll[0]!, "meanScore")
      )
    ).toBeLessThan(1e-12)
    expect(aggregate["scores.explicitPassCount"]).toBe(
      numberAt(rawAll[0]!, "explicitPassCount")
    )
    expect(aggregate["scores.explicitFailCount"]).toBe(
      numberAt(rawAll[0]!, "explicitFailCount")
    )
    expect(
      Math.abs(
        Number(aggregate["scores.explicitPassRate"]) -
          numberAt(rawAll[0]!, "explicitPassCount") /
            (numberAt(rawAll[0]!, "explicitPassCount") +
              numberAt(rawAll[0]!, "explicitFailCount"))
      )
    ).toBeLessThan(1e-12)
    expect(aggregate["scores.errorCount"]).toBe(
      numberAt(rawAll[0]!, "errorCount")
    )
    expect(aggregate["scores.failedCheckCount"]).toBe(
      numberAt(rawAll[0]!, "failedCheckCount")
    )
    expect(aggregate["scores.uniqueTraceCount"]).toBe(
      numberAt(rawAll[0]!, "uniqueTraceCount")
    )
    expect(allScores.meta.quality.status).toBe("partial")
    expect(allScores.meta.quality.warnings.join(" ")).toContain(
      "technical error"
    )

    const rawDatasets = await rawRows(
      fixture.database,
      `SELECT item.dataset_id AS datasetId, COUNT(result.id) AS executionCount
       FROM eval_results AS result
       LEFT JOIN dataset_items AS item ON item.id = result.dataset_item_id
       WHERE result.run_id = $1
       GROUP BY item.dataset_id
       ORDER BY item.dataset_id ASC NULLS FIRST`,
      ["run_mixed"]
    )
    const mixedDataset = await runQuery(fixture, {
      dimensions: ["scores.datasetId"],
      filters: [
        {
          member: "scores.evalRunId",
          operator: "equals",
          values: ["run_mixed"],
        },
      ],
      measures: ["scores.executionCount"],
      timeDimensions: [
        {
          dateRange: ["2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"],
          dimension: "scores.completedAt",
          granularity: "day",
        },
      ],
      timezone: "UTC",
    })
    expect(mixedDataset.data).toEqual(
      rawDatasets.map((row) => ({
        "scores.completedAt": "2026-09-01",
        "scores.datasetId": row.datasetId as string | null,
        "scores.executionCount": numberAt(row, "executionCount"),
      }))
    )
    expect(mixedDataset.data.map((row) => row["scores.datasetId"])).toEqual([
      null,
      "ds_alpha",
    ])

    const rawVersions = await rawRows(
      fixture.database,
      `SELECT version.version AS evaluatorVersion, result.evaluator_version_id AS evaluatorVersionId, COUNT(result.id) AS executionCount
       FROM eval_results AS result
       JOIN evaluator_versions AS version ON version.id = result.evaluator_version_id
       WHERE result.evaluator_id = $1
         AND COALESCE(result.completed_at, result.created_at) >= $2
         AND COALESCE(result.completed_at, result.created_at) < $3
       GROUP BY version.version, result.evaluator_version_id
       ORDER BY version.version ASC`,
      ["ev_quality", "2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"]
    )
    const versions = await runQuery(fixture, {
      dimensions: ["scores.evaluatorVersion", "scores.evaluatorVersionId"],
      filters: [
        {
          member: "scores.evaluatorId",
          operator: "equals",
          values: ["ev_quality"],
        },
      ],
      measures: ["scores.executionCount"],
      timeDimensions: [
        {
          dateRange: ["2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"],
          dimension: "scores.completedAt",
          granularity: "day",
        },
      ],
      timezone: "UTC",
    })
    expect(versions.data).toEqual(
      rawVersions.map((row) => ({
        "scores.completedAt": "2026-09-01",
        "scores.evaluatorVersion": numberAt(row, "evaluatorVersion"),
        "scores.evaluatorVersionId": row.evaluatorVersionId as string,
        "scores.executionCount": numberAt(row, "executionCount"),
      }))
    )
    expect(versions.data.map((row) => row["scores.evaluatorVersion"])).toEqual([
      1, 2,
    ])

    const errorOnly = await runQuery(fixture, {
      measures: [
        "scores.executionCount",
        "scores.scoredCount",
        "scores.meanScore",
        "scores.explicitPassRate",
        "scores.errorCount",
      ],
      filters: [
        { member: "scores.status", operator: "equals", values: ["error"] },
      ],
      timeDimensions: [
        {
          dateRange: ["2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"],
          dimension: "scores.completedAt",
          granularity: "day",
        },
      ],
      timezone: "UTC",
    })
    // A technical evaluator error is an execution with null score/pass, never
    // an invented zero score or explicit failed pass.
    expect(errorOnly.data).toEqual([
      {
        "scores.completedAt": "2026-09-01",
        "scores.errorCount": 1,
        "scores.executionCount": 1,
        "scores.explicitPassRate": null,
        "scores.meanScore": null,
        "scores.scoredCount": 0,
      },
    ])

    const invalid = await runQuery(fixture, {
      measures: [
        "scores.executionCount",
        "scores.scoredCount",
        "scores.meanScore",
      ],
      timeDimensions: [
        {
          dateRange: ["2026-09-05T00:00:00.000Z", "2026-09-06T00:00:00.000Z"],
          dimension: "scores.completedAt",
          granularity: "day",
        },
      ],
      timezone: "UTC",
    })
    expect(invalid.data[0]).toMatchObject({
      "scores.executionCount": 1,
      "scores.meanScore": null,
      "scores.scoredCount": 0,
    })
    expect(invalid.meta.quality.status).toBe("partial")
    expect(invalid.meta.quality.warnings.join(" ")).toContain("status ok")
  })

  test("rejects malformed, cross-model, and filter-only grouping input before opening a snapshot", async () => {
    const fixture = await createFixture()
    let snapshots = 0
    const neverRead: SemanticSnapshotRunner = async () => {
      snapshots += 1
      throw new Error(
        "Input validation must run before opening a semantic snapshot."
      )
    }
    const service = createSemanticQueryService({
      catalog: fixture.catalog,
      database: fixture.database,
      snapshotRunner: neverRead,
    })

    const malformed = await capturedError(() =>
      Effect.runPromise(service.query({ measures: [] }))
    )
    expect(malformed).toMatchObject({ code: "INVALID_QUERY" })

    const crossModel = await capturedError(() =>
      Effect.runPromise(
        service.query({ measures: ["traces.count", "evalRuns.count"] })
      )
    )
    expect(crossModel).toMatchObject({ code: "INVALID_QUERY" })

    const filterOnlyGroup = await capturedError(() =>
      Effect.runPromise(
        service.query({
          dimensions: ["traces.parent.sessionId"],
          measures: ["traces.count"],
          timeDimensions: [
            {
              dateRange: [
                "2026-09-01T00:00:00.000Z",
                "2026-09-02T00:00:00.000Z",
              ],
              dimension: "traces.startedAt",
              granularity: "day",
            },
          ],
        })
      )
    )
    expect(filterOnlyGroup).toBeInstanceOf(SemanticExecutionError)
    expect(filterOnlyGroup).toMatchObject({
      code: "MEMBER_NOT_GROUPABLE",
      path: ["dimensions", 0],
    })
    expect(snapshots).toBe(0)
  })

  test("keeps page data and total on one read-only snapshot while normal app and second-client writers commit", async () => {
    const fixture = await createFixture()
    const canonical = createSemanticSnapshotRunner(fixture.database)

    const runWriterCase = async (
      operation: string,
      afterId: string,
      write: () => Promise<unknown>
    ) => {
      const snapshotReady = deferred<void>()
      const writerFinished = deferred<void>()
      const snapshotRunner: SemanticSnapshotRunner = (callback) =>
        canonical(async (snapshot, asOf) => {
          // Establish the SQLite snapshot before allowing the writer to start.
          await snapshot.select({ id: traces.id }).from(traces).limit(1)
          snapshotReady.resolve()
          await writerFinished.promise
          return callback(snapshot, asOf)
        })
      const service = createSemanticQueryService({
        catalog: fixture.catalog,
        database: fixture.database,
        now: () => new Date(FIXTURE_NOW),
        requestId: () => `snapshot_${afterId}`,
        snapshotRunner,
      })
      const query = Effect.runPromise(service.query(traceQuery(operation)))
      await resolvesWithin(snapshotReady.promise)
      await resolvesWithin(write())
      writerFinished.resolve()
      const result = await resolvesWithin(query)
      expect(result.data).toEqual([
        {
          "traces.count": 1,
          "traces.startedAt": "2026-09-03",
        },
      ])
      expect(result.meta.page.total).toBe(1)
      expect(Number.isFinite(Date.parse(result.meta.asOf))).toBe(true)
      const after = await rawRows(
        fixture.database,
        "SELECT COUNT(*) AS count FROM traces WHERE operation = $1",
        [operation]
      )
      expect(numberAt(after[0]!, "count")).toBe(2)
    }

    await runWriterCase("qa.snapshot.app", "tr_snapshot_app_after", () =>
      raw(
        fixture.database,
        "INSERT INTO traces (id, session_id, name, operation, input_json, output_json, attributes_json, status, started_at, ended_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        traceValues(
          "tr_snapshot_app_after",
          "qa.snapshot.app",
          "completed",
          "2026-09-03T12:10:00.000Z",
          "2026-09-03T12:10:01.000Z"
        )
      )
    )

    const external = new Pool({ connectionString: fixture.target.databaseUrl })
    try {
      await runWriterCase(
        "qa.snapshot.external",
        "tr_snapshot_external_after",
        () =>
          external.query(
            "INSERT INTO traces (id, session_id, name, operation, input_json, output_json, attributes_json, status, started_at, ended_at, project_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
            [
              ...traceValues(
                "tr_snapshot_external_after",
                "qa.snapshot.external",
                "completed",
                "2026-09-03T12:11:00.000Z",
                "2026-09-03T12:11:01.000Z"
              ),
              fixture.target.projectId,
            ]
          )
      )
    } finally {
      await external.end()
    }
  })

  test("rejects escaped writes through a semantic snapshot at runtime and restores normal writes after release", async () => {
    const fixture = await createFixture()
    const runner = createSemanticSnapshotRunner(fixture.database)
    const modelFailure = await capturedError(() =>
      runner(async () => {
        throw new Error("intentional semantic model failure")
      })
    )
    expect(modelFailure).toBeInstanceOf(Error)

    const failure = await capturedError(() =>
      runner(async (snapshot) => {
        const escaped = snapshot as unknown as {
          $client: {
            query: (
              sql: string,
              values: readonly SqlValue[]
            ) => Promise<unknown>
          }
        }
        await escaped.$client.query(
          "INSERT INTO traces (id, session_id, name, operation, input_json, output_json, attributes_json, status, started_at, ended_at, project_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
          [
            ...traceValues(
              "tr_snapshot_illegal_write",
              "qa.snapshot.illegal",
              "completed",
              "2026-09-03T12:20:00.000Z",
              "2026-09-03T12:20:01.000Z"
            ),
            fixture.target.projectId,
          ]
        )
      })
    )
    expect(failure).toBeInstanceOf(Error)
    const prohibited = await rawRows(
      fixture.database,
      "SELECT COUNT(*) AS count FROM traces WHERE id = $1",
      ["tr_snapshot_illegal_write"]
    )
    expect(numberAt(prohibited[0]!, "count")).toBe(0)

    await raw(
      fixture.database,
      "INSERT INTO traces (id, session_id, name, operation, input_json, output_json, attributes_json, status, started_at, ended_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
      traceValues(
        "tr_snapshot_post_failure",
        "qa.snapshot.post-release",
        "completed",
        "2026-09-03T12:21:00.000Z",
        "2026-09-03T12:21:01.000Z"
      )
    )
    const restored = await rawRows(
      fixture.database,
      "SELECT COUNT(*) AS count FROM traces WHERE id = $1",
      ["tr_snapshot_post_failure"]
    )
    expect(numberAt(restored[0]!, "count")).toBe(1)
  })
})
