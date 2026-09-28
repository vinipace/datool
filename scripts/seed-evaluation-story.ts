/** Additive local fixture for the precision/cost report. No model calls. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { Pool } from "pg"
import { promptInputSchema } from "../src/lib/tracer/prompts"
import { scorerInputSchema } from "../src/lib/tracer/scorers"

const url = process.env.DATABASE_URL
assert(
  url && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname),
  "Use local PostgreSQL"
)
const slug = process.argv[2]
assert(slug, "Pass an existing local project slug")
const pool = new Pool({ connectionString: url })
type Row = Record<string, string | number | boolean | null>
const tables = new Map<string, Row[]>()
const json = JSON.stringify
const add = (table: string, row: Row) =>
  tables.set(table, [...(tables.get(table) ?? []), row])
const operation = "Synthetic / Ticket escalation"
const segments = ["Billing", "Account access", "Technical", "Ambiguous"]
const profiles = [
  { name: "v1 · Baseline", tp: [20, 16, 14, 10], usd: 0.025, ms: 4800 },
  {
    name: "v2 · Clear instructions",
    tp: [34, 32, 29, 25],
    usd: 0.03,
    ms: 5200,
  },
  { name: "v3 · Grounded policy", tp: [44, 42, 40, 38], usd: 0.018, ms: 3000 },
  {
    name: "v4 · Efficient candidate",
    tp: [49, 48, 47, 46],
    usd: 0.009,
    ms: 1600,
  },
]
// Fixed benchmark: four equal segments, 60 positive + 40 negative cases each.
// Each version predicts 50 positives per segment; precision denominator = 200.
const end = Date.parse("2026-09-27T00:00:00Z")
const iso = (ms: number) => new Date(ms).toISOString()
const created = iso(end - 5 * 86400000)
const metadata = json({ synthetic: true, fixture: "precision-cost-story-v1" })
try {
  const { rows } = await pool.query("SELECT id FROM project WHERE slug=$1", [
    slug,
  ])
  assert(rows.length === 1, "Expected one existing local project")
  const project = rows[0].id as string
  const prefix = `story-${createHash("sha256").update(project).digest("hex").slice(0, 6)}`
  const promptId = `${prefix}-prompt`
  const scorerId = (s: number) => `${prefix}-scorer-${s}`
  const datasetId = (d: number) => `Story / ${segments[d]}`
  const itemId = (d: number, c: number) => `${prefix}-item-${d}-${c}`
  const promptConfigs = profiles.map((profile) =>
    promptInputSchema.parse({
      name: "Synthetic escalation benchmark",
      slug: "escalation-story",
      description: "Synthetic scenario; no model execution.",
      metadata: { synthetic: true },
      provider: "vercel-ai-gateway",
      model: "openai/gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: `${profile.name}: classify whether this ticket requires specialist escalation.`,
        },
        { role: "user", content: "{{ticket}}" },
      ],
      template: "mustache",
      output: "text",
      temperature: 0,
    })
  )
  add("managed_prompts", {
    id: promptId,
    project_id: project,
    slug: "escalation-story",
    config_json: json(promptConfigs[3]),
    revision: 4,
    published_version: 4,
    published_config_json: json(promptConfigs[3]),
    published_at: created,
    created_at: created,
    updated_at: created,
  })
  promptConfigs.forEach((config, v) =>
    add("managed_prompt_versions", {
      id: `${promptId}-v${v + 1}`,
      project_id: project,
      prompt_id: promptId,
      revision: v + 1,
      config_json: json(config),
      created_at: created,
    })
  )
  for (const [s, name] of ["Precision", "Recall", "Accuracy"].entries()) {
    const code = `function evaluate({ trace }) { const actual = trace.input.requiresEscalation; const predicted = trace.output.escalate; const eligible = ${s === 0 ? "predicted" : s === 1 ? "actual" : "true"}; return { score: eligible ? Number(${s === 2 ? "actual === predicted" : "actual && predicted"}) : null, reasoning: eligible ? 'Synthetic binary classification' : 'Outside this metric denominator' }; }`
    const config = scorerInputSchema.parse({
      name,
      slug: `story-${name.toLowerCase()}`,
      description:
        "Synthetic binary classification. Precision conditions on predicted positives; recall on actual positives; accuracy covers all cases.",
      type: "javascript",
      code,
      threshold: 1,
    })
    add("evaluators", {
      id: scorerId(s),
      project_id: project,
      name,
      description: config.description,
      active_version_id: `${scorerId(s)}-v1`,
      created_at: created,
      updated_at: created,
    })
    add("evaluator_versions", {
      id: `${scorerId(s)}-v1`,
      project_id: project,
      evaluator_id: scorerId(s),
      version: 1,
      language: "javascript",
      code,
      config_json: json(config),
      created_at: created,
    })
    add("scorers", {
      id: scorerId(s),
      project_id: project,
      slug: config.slug,
      config_json: json(config),
      revision: 1,
      created_at: created,
      updated_at: created,
    })
  }
  for (const [d, segment] of segments.entries()) {
    add("datasets", {
      id: datasetId(d),
      project_id: project,
      name: `Story / ${segment}`,
      description:
        "Fixed synthetic benchmark: 60 positive and 40 negative cases.",
      metadata_json: metadata,
      created_at: created,
      updated_at: created,
    })
    for (let c = 0; c < 100; c++)
      add("dataset_items", {
        id: itemId(d, c),
        project_id: project,
        dataset_id: datasetId(d),
        input_json: json({
          ticket: `${segment} synthetic case ${c + 1}`,
          requiresEscalation: c < 60,
        }),
        expected_output_json: json({ escalate: c < 60 }),
        metadata_json: metadata,
        created_at: created,
        updated_at: created,
      })
  }
  for (const [v, profile] of profiles.entries()) {
    for (const [d, segment] of segments.entries()) {
      const started = end - (4 - v) * 86400000 + d * 3600000
      const runId = `${prefix}-run-${v}-${d}`
      const group = {
        group_type: "agent",
        group_name: operation,
        group_version: profile.name,
      }
      add("eval_runs", {
        id: runId,
        project_id: project,
        name: `${profile.name} / ${segment}`,
        dataset_id: datasetId(d),
        status: "completed",
        metadata_json: metadata,
        created_at: iso(started),
        completed_at: iso(started + 100 * 10000),
        groups_resolved_at: iso(started + 100 * 10000),
      })
      add("eval_run_groups", {
        id: `${runId}-group`,
        project_id: project,
        run_id: runId,
        ...group,
      })
      for (let s = 0; s < 3; s++)
        add("eval_run_evaluators", {
          id: `${runId}-scorer-${s}`,
          project_id: project,
          run_id: runId,
          evaluator_id: scorerId(s),
          evaluator_version_id: `${scorerId(s)}-v1`,
        })
      for (let c = 0; c < 100; c++) {
        const actual = c < 60
        const predicted = actual
          ? c < profile.tp[d]
          : c - 60 < 50 - profile.tp[d]
        const traceId = `${runId}-trace-${c}`,
          targetId = `${runId}-target-${c}`
        const timestamp = started + c * 10000
        const duration = Math.round(profile.ms * (0.6 + (c % 20) / 25))
        const attributes = {
          synthetic: true,
          "demo.fixture": "precision-cost-story-v1",
          "cost.usd": profile.usd,
          "cost.status": "calculated",
          "gen_ai.request.model": "synthetic-model",
          "usage.input_tokens": 600,
          "usage.output_tokens": 40,
          "datool.prompt.id": promptId,
          "datool.prompt.slug": "escalation-story",
          "datool.prompt.version": v + 1,
        }
        const input = {
          ticket: `${segment} synthetic case ${c + 1}`,
          requiresEscalation: actual,
        }
        const output = { escalate: predicted, synthetic: true }
        add("traces", {
          id: traceId,
          project_id: project,
          name: `${profile.name} / ${segment} #${c + 1}`,
          operation: "agent",
          ...group,
          status: "completed",
          input_json: json(input),
          output_json: json(output),
          attributes_json: json(attributes),
          started_at: iso(timestamp),
          ended_at: iso(timestamp + duration),
        })
        add("spans", {
          id: `${traceId}-llm`,
          project_id: project,
          trace_id: traceId,
          name: "Synthetic classification",
          kind: "llm",
          ...group,
          status: "completed",
          input_json: json(input),
          output_json: json(output),
          attributes_json: json(attributes),
          started_at: iso(timestamp),
          ended_at: iso(timestamp + duration),
        })
        add("eval_run_targets", {
          ordinal: c,
          stage: "completed",
          created_at: iso(timestamp),
          id: targetId,
          project_id: project,
          run_id: runId,
          trace_id: traceId,
          dataset_item_id: itemId(d, c),
          snapshot_json: json({
            targetId,
            datasetItem: {
              id: itemId(d, c),
              datasetId: datasetId(d),
              input,
              expectedOutput: { escalate: actual },
              metadata: { synthetic: true },
            },
            trace: {
              id: traceId,
              name: `${segment} case ${c + 1}`,
              operation: "agent",
              input,
              output,
              attributes,
              status: "completed",
              startedAt: iso(timestamp),
              endedAt: iso(timestamp + duration),
              sessionId: null,
              group: { type: "agent", name: operation, version: profile.name },
              spans: [],
            },
          }),
        })
        add("eval_target_attributions", {
          id: `${targetId}-attribution`,
          project_id: project,
          run_id: runId,
          target_id: targetId,
          ...group,
          models_json: json(["synthetic-model"]),
          source_trace_id: traceId,
          source_span_id: `${traceId}-llm`,
          prompt_versions_json: json([
            { id: promptId, slug: "escalation-story", version: v + 1 },
          ]),
        })
        const values = [
          predicted ? Number(actual) : null,
          actual ? Number(predicted) : null,
          Number(actual === predicted),
        ]
        values.forEach((score, s) => {
          const resultId = `${targetId}-result-${s}`
          add("eval_results", {
            id: resultId,
            project_id: project,
            run_id: runId,
            target_id: targetId,
            trace_id: traceId,
            dataset_item_id: itemId(d, c),
            evaluator_id: scorerId(s),
            evaluator_version_id: `${scorerId(s)}-v1`,
            score,
            passed: score === null ? null : score === 1,
            status: "completed",
            reasoning:
              score === null
                ? "Outside this metric denominator"
                : "Synthetic binary classification",
            error: null,
            metadata_json: metadata,
            created_at: iso(timestamp + duration),
            completed_at: iso(timestamp + duration),
          })
          add("scores", {
            id: `${resultId}-score`,
            project_id: project,
            trace_id: traceId,
            eval_result_id: resultId,
            evaluator_id: scorerId(s),
            name: "score",
            value: score,
            status: "ok",
            created_at: iso(timestamp + duration),
          })
        })
      }
    }
  }
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    for (const [table, rows] of tables) {
      assert(/^[a-z_]+$/.test(table))
      const columns = Object.keys(rows[0])
      for (let i = 0; i < rows.length; i += 100) {
        const batch = rows.slice(i, i + 100)
        await client.query(
          `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(",")}) VALUES ${batch.map((_, n) => `(${columns.map((_, m) => `$${n * columns.length + m + 1}`).join(",")})`).join(",")} ON CONFLICT (id) DO NOTHING`,
          batch.flatMap((row) => columns.map((c) => row[c] ?? null))
        )
      }
    }
    await client.query("COMMIT")
    for (const table of tables.keys()) await client.query(`ANALYZE "${table}"`)
    console.log(
      json({
        operation,
        synthetic: true,
        casesPerVersion: 400,
        versions: 4,
        dateRange: [created, iso(end)],
        expectedPrecision: profiles.map(
          (p) => p.tp.reduce((a, b) => a + b) / 200
        ),
      })
    )
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
} finally {
  await pool.end()
}
