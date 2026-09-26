import { afterEach, describe, expect, test } from "bun:test"

import { Pool } from "pg"

import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
  type IsolatedPostgres,
} from "./helpers/postgres"

const tracerTables = [
  "sessions",
  "traces",
  "spans",
  "datasets",
  "dataset_items",
  "evaluators",
  "evaluator_versions",
  "eval_runs",
  "eval_run_evaluators",
  "eval_run_targets",
  "eval_results",
  "scores",
  "saved_views",
]

describe("PostgreSQL project-scoped tracer storage", () => {
  let target: IsolatedPostgres | undefined

  afterEach(async () => {
    await target?.close()
    target = undefined
  })

  test("preserves nullable references and cascades a complete evaluation graph when its project is deleted", async () => {
    target = await createIsolatedPostgres()
    await migrateIsolatedPostgres(target)
    await seedTestWorkspace(target)

    const pool = new Pool({ connectionString: target.databaseUrl })
    const now = new Date().toISOString()
    const ids = {
      dataset: crypto.randomUUID(),
      evaluator: crypto.randomUUID(),
      evaluatorVersion: crypto.randomUUID(),
      item: crypto.randomUUID(),
      result: crypto.randomUUID(),
      rootSpan: crypto.randomUUID(),
      run: crypto.randomUUID(),
      runEvaluator: crypto.randomUUID(),
      score: crypto.randomUUID(),
      session: crypto.randomUUID(),
      span: crypto.randomUUID(),
      target: crypto.randomUUID(),
      trace: crypto.randomUUID(),
      view: crypto.randomUUID(),
    }

    try {
      await pool.query(
        `INSERT INTO sessions (id, project_id, name, attributes_json, created_at, updated_at)
         VALUES ($1, $2, 'session', '{}', $3, $3)`,
        [ids.session, target.projectId, now],
      )
      await pool.query(
        `INSERT INTO traces (id, project_id, session_id, name, operation, attributes_json, status, started_at)
         VALUES ($1, $2, $3, 'trace', 'workflow', '{}', 'completed', $4)`,
        [ids.trace, target.projectId, ids.session, now],
      )
      await pool.query(
        `INSERT INTO spans (id, project_id, trace_id, name, kind, attributes_json, status, started_at)
         VALUES ($1, $2, $3, 'root', 'workflow', '{}', 'completed', $4)`,
        [ids.rootSpan, target.projectId, ids.trace, now],
      )
      await pool.query(
        `INSERT INTO spans (id, project_id, trace_id, parent_id, name, kind, attributes_json, status, started_at)
         VALUES ($1, $2, $3, $4, 'child', 'tool', '{}', 'completed', $5)`,
        [ids.span, target.projectId, ids.trace, ids.rootSpan, now],
      )
      await pool.query(
        `INSERT INTO datasets (id, project_id, name, created_at, updated_at) VALUES ($1, $2, 'dataset', $3, $3)`,
        [ids.dataset, target.projectId, now],
      )
      await pool.query(
        `INSERT INTO dataset_items (id, project_id, dataset_id, input_json, metadata_json, source_trace_id, created_at, updated_at)
         VALUES ($1, $2, $3, '{}', '{}', $4, $5, $5)`,
        [ids.item, target.projectId, ids.dataset, ids.trace, now],
      )
      await pool.query(
        `INSERT INTO evaluators (id, project_id, name, created_at, updated_at) VALUES ($1, $2, 'evaluator', $3, $3)`,
        [ids.evaluator, target.projectId, now],
      )
      await pool.query(
        `INSERT INTO evaluator_versions (id, project_id, evaluator_id, version, language, code, created_at)
         VALUES ($1, $2, $3, 1, 'javascript', 'function evaluate() { return { score: 1 } }', $4)`,
        [ids.evaluatorVersion, target.projectId, ids.evaluator, now],
      )
      await pool.query(
        `INSERT INTO eval_runs (id, project_id, dataset_id, status, created_at) VALUES ($1, $2, $3, 'completed', $4)`,
        [ids.run, target.projectId, ids.dataset, now],
      )
      await pool.query(
        `INSERT INTO eval_run_evaluators (id, project_id, run_id, evaluator_id, evaluator_version_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [ids.runEvaluator, target.projectId, ids.run, ids.evaluator, ids.evaluatorVersion],
      )
      await pool.query(
        `INSERT INTO eval_run_targets (id, project_id, run_id, trace_id, dataset_item_id, ordinal, created_at)
         VALUES ($1, $2, $3, $4, $5, 0, $6)`,
        [ids.target, target.projectId, ids.run, ids.trace, ids.item, now],
      )
      await pool.query(
        `INSERT INTO eval_results (id, project_id, run_id, trace_id, dataset_item_id, evaluator_id, evaluator_version_id, score, passed, status, metadata_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, true, 'completed', '{}', $8)`,
        [ids.result, target.projectId, ids.run, ids.trace, ids.item, ids.evaluator, ids.evaluatorVersion, now],
      )
      await pool.query(
        `INSERT INTO scores (id, project_id, trace_id, eval_result_id, evaluator_id, name, value, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'quality', 1, 'ok', $6)`,
        [ids.score, target.projectId, ids.trace, ids.result, ids.evaluator, now],
      )
      await pool.query(
        `INSERT INTO saved_views (id, project_id, name, resource, columns_json, created_at, updated_at)
         VALUES ($1, $2, 'view', 'eval-results', '[]', $3, $3)`,
        [ids.view, target.projectId, now],
      )

      await pool.query(`DELETE FROM sessions WHERE id = $1`, [ids.session])
      const detachedTrace = await pool.query<{ project_id: string; session_id: string | null }>(
        `SELECT project_id, session_id FROM traces WHERE id = $1`,
        [ids.trace],
      )
      expect(detachedTrace.rows[0]).toEqual({ project_id: target.projectId, session_id: null })

      await pool.query(`DELETE FROM dataset_items WHERE id = $1`, [ids.item])
      const optionalReferences = await pool.query<{ dataset_item_id: string | null; project_id: string }>(
        `SELECT dataset_item_id, project_id FROM eval_run_targets WHERE id = $1
         UNION ALL
         SELECT dataset_item_id, project_id FROM eval_results WHERE id = $2`,
        [ids.target, ids.result],
      )
      expect(optionalReferences.rows).toEqual([
        { dataset_item_id: null, project_id: target.projectId },
        { dataset_item_id: null, project_id: target.projectId },
      ])

      await pool.query(`DELETE FROM project WHERE id = $1`, [target.projectId])
      for (const table of tracerTables) {
        const result = await pool.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`)
        expect(result.rows[0]?.count).toBe("0")
      }
    } finally {
      await pool.end()
    }
  })
})
