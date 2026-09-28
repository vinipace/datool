import { dashboardReportDocument } from "../src/lib/tracer/report-mdx"
import { createHash } from "node:crypto"
import { Pool, type PoolClient } from "pg"
import { promptInputSchema } from "../src/lib/tracer/prompts"
import { scorerInputSchema } from "../src/lib/tracer/scorers"
import { reportTemplates } from "../src/lib/tracer/report-templates"
import {
  createTracerDatabase,
  closeTracerDatabase,
} from "../src/server/tracer/db"
import { createDashboardService } from "../src/server/tracer/dashboards"
import { createReportService } from "../src/server/tracer/reports"
import { runTracerEffect as run } from "../src/server/tracer/effect"

// Local-only, additive and repeatable. No model calls or existing-data updates.
const projectSlug = process.argv[2]
if (!projectSlug)
  throw new Error(
    "Usage: bun --env-file=.env.local scripts/seed-reports-demo.ts <project-slug>"
  )
const databaseUrl = process.env.DATABASE_URL
if (
  !databaseUrl ||
  !["localhost", "127.0.0.1", "[::1]"].includes(new URL(databaseUrl).hostname)
)
  throw new Error("Demo seeding requires a local PostgreSQL DATABASE_URL.")

type Row = Record<string, string | number | boolean | null>
const rows = new Map<string, Row[]>()
const add = (table: string, row: Row) => {
  const values = rows.get(table) ?? []
  values.push(row)
  rows.set(table, values)
}
async function insert(client: PoolClient, table: string, values: Row[]) {
  const columns = [...new Set(values.flatMap((row) => Object.keys(row)))]
  if (![table, ...columns].every((key) => /^[a-z_]+$/.test(key)))
    throw new Error("Invalid seed identifier")
  let inserted = 0
  for (let start = 0; start < values.length; start += 250) {
    const batch = values.slice(start, start + 250)
    const placeholders = batch
      .map(
        (_, i) =>
          `(${columns.map((_, j) => `$${i * columns.length + j + 1}`).join(",")})`
      )
      .join(",")
    const result = await client.query(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(",")}) VALUES ${placeholders} ON CONFLICT (id) DO NOTHING`,
      batch.flatMap((row) => columns.map((column) => row[column] ?? null))
    )
    inserted += result.rowCount ?? 0
  }
  console.log(`${table}: ${inserted} added (${values.length} demo records)`)
}

const pool = new Pool({ connectionString: databaseUrl })
try {
  const projects = await pool.query<{ id: string }>(
    "SELECT id FROM project WHERE slug=$1",
    [projectSlug]
  )
  if (projects.rows.length !== 1)
    throw new Error("Expected one existing demo project with this slug.")
  const projectId = projects.rows[0].id
  const suffix = createHash("sha256")
    .update(projectId)
    .digest("hex")
    .slice(0, 6)
  const prefix = `demo-reports-${suffix}`
  const base = Date.now() - 10 * 60000
  const iso = (ms: number) => new Date(ms).toISOString()
  const created = iso(base - 14 * 86400000)
  const metadata = JSON.stringify({
    synthetic: true,
    fixture: "reports-demo-v1",
  })
  const operations = [
    {
      slug: "demo-support",
      name: "Demo / Customer support",
      type: "agent",
      question: "How can I return an item that arrived damaged?",
      answer:
        "Start a return from your order, attach a photo, and choose a refund or replacement.",
    },
    {
      slug: "demo-knowledge",
      name: "Demo / Knowledge search",
      type: "workflow",
      question: "What does the enterprise plan include?",
      answer:
        "The enterprise plan includes SSO, audit logs, priority support, and configurable retention.",
    },
    {
      slug: "demo-triage",
      name: "Demo / Ticket triage",
      type: "agent",
      question: "I cannot sign in after enabling two-factor authentication.",
      answer:
        "Route to account access with high priority; request a recovery code without asking for credentials.",
    },
  ]
  const datasets = [
    "English support",
    "Portuguese support",
    "Technical questions",
    "Adversarial cases",
  ]
  const profiles = [
    {
      label: "Baseline",
      quality: 0.58,
      latency: 1700,
      rate: 1,
      model: "openai/gpt-4.1-mini",
    },
    {
      label: "Few-shot",
      quality: 0.69,
      latency: 2100,
      rate: 1.2,
      model: "openai/gpt-4.1-mini",
    },
    {
      label: "Grounded",
      quality: 0.82,
      latency: 3100,
      rate: 3,
      model: "openai/gpt-4.1",
    },
    {
      label: "Reasoning",
      quality: 0.91,
      latency: 4700,
      rate: 5,
      model: "anthropic/claude-sonnet-4",
    },
    {
      label: "Efficient",
      quality: 0.85,
      latency: 1200,
      rate: 0.65,
      model: "openai/gpt-4.1-mini",
    },
  ]
  const scorerNames = [
    "Answer correctness",
    "Groundedness",
    "Safety and relevance",
  ]
  const scorerId = (s: number) => `${prefix}-scorer-${s}`
  const datasetId = (d: number) =>
    `${datasets[d].toLowerCase().replaceAll(" ", "-")}-${suffix}`
  const itemId = (d: number, o: number, c: number) =>
    `${prefix}-item-${d}-${o}-${c}`
  const promptId = (o: number) => `${prefix}-prompt-${o}`

  for (const [o, operation] of operations.entries()) {
    const configs = profiles.map((profile, version) =>
      promptInputSchema.parse({
        name: `${operation.name} prompt`,
        slug: operation.slug,
        description:
          "Synthetic report demo prompt. No provider calls were made.",
        metadata: { synthetic: true },
        provider: "vercel-ai-gateway",
        model: profile.model,
        messages: [
          {
            role: "system",
            content: `${profile.label} candidate v${version + 1}. Answer accurately using the supplied context. Acknowledge uncertainty and protect private information.`,
          },
          { role: "user", content: "{{question}}" },
        ],
        template: "mustache",
        output: "text",
        temperature: 0.2,
      })
    )
    add("managed_prompts", {
      id: promptId(o),
      project_id: projectId,
      slug: operation.slug,
      config_json: JSON.stringify(configs[4]),
      revision: 5,
      published_version: 5,
      published_config_json: JSON.stringify(configs[4]),
      published_at: created,
      created_at: created,
      updated_at: created,
    })
    configs.forEach((config, v) =>
      add("managed_prompt_versions", {
        id: `${promptId(o)}-v${v + 1}`,
        project_id: projectId,
        prompt_id: promptId(o),
        revision: v + 1,
        config_json: JSON.stringify(config),
        created_at: created,
      })
    )
  }
  for (const [s, name] of scorerNames.entries()) {
    const code =
      "function evaluate({ trace }) { return { score: typeof trace.output?.demoScore === 'number' ? trace.output.demoScore : 0, reasoning: 'Synthetic demo scorer.' }; }"
    const config = scorerInputSchema.parse({
      name: `Demo / ${name}`,
      slug: `demo-${name.toLowerCase().replaceAll(" ", "-")}`,
      description: "Synthetic normalized scores for report exploration.",
      type: "javascript",
      code,
      threshold: 0.75,
    })
    add("evaluators", {
      id: scorerId(s),
      project_id: projectId,
      name: config.name,
      description: config.description,
      active_version_id: `${scorerId(s)}-v1`,
      created_at: created,
      updated_at: created,
    })
    add("evaluator_versions", {
      id: `${scorerId(s)}-v1`,
      project_id: projectId,
      evaluator_id: scorerId(s),
      version: 1,
      language: "javascript",
      code,
      config_json: JSON.stringify(config),
      created_at: created,
    })
    add("scorers", {
      id: scorerId(s),
      project_id: projectId,
      slug: config.slug,
      config_json: JSON.stringify(config),
      revision: 1,
      created_at: created,
      updated_at: created,
    })
  }
  for (const [d, name] of datasets.entries()) {
    add("datasets", {
      id: datasetId(d),
      project_id: projectId,
      name: `Demo / ${name}`,
      description:
        "Synthetic evaluation cases for comparing report candidates.",
      metadata_json: metadata,
      created_at: created,
      updated_at: created,
    })
    for (const [o, operation] of operations.entries())
      for (let c = 0; c < 6; c++) {
        add("dataset_items", {
          id: itemId(d, o, c),
          project_id: projectId,
          dataset_id: datasetId(d),
          input_json: JSON.stringify({
            question: operation.question,
            locale: d === 1 ? "pt-BR" : "en",
            variation: c + 1,
            difficulty: d === 3 ? "adversarial" : c > 3 ? "hard" : "standard",
          }),
          expected_output_json: JSON.stringify({ answer: operation.answer }),
          metadata_json: metadata,
          created_at: created,
          updated_at: created,
        })
      }
  }
  let index = 0
  for (let day = 0; day < 14; day++)
    for (const [o, operation] of operations.entries())
      for (const [v, profile] of profiles.entries())
        for (let d = 0; d < datasets.length; d++) {
          const runId = `${prefix}-run-${day}-${o}-${v}-${d}`
          const started =
            base - day * 86400000 - (o * 180 + v * 30 + d * 6 + 6) * 60000
          const group = {
            group_type: operation.type,
            group_name: operation.name,
            group_version: `v${v + 1}`,
          }
          let errors = 0
          add("eval_run_groups", {
            id: `${runId}-group`,
            project_id: projectId,
            run_id: runId,
            ...group,
          })
          for (let s = 0; s < 3; s++)
            add("eval_run_evaluators", {
              id: `${runId}-scorer-${s}`,
              project_id: projectId,
              run_id: runId,
              evaluator_id: scorerId(s),
              evaluator_version_id: `${scorerId(s)}-v1`,
            })
          for (let c = 0; c < 6; c++) {
            index++
            const noise = ((index * 73) % 101) / 100
            const error = index % 43 === 0
            const traceId = `${runId}-trace-${c}`
            const targetId = `${runId}-case-${c}`
            const timestamp = started + c * 60000
            const duration = Math.round(
              profile.latency * (0.65 + noise) +
                (d === 3 ? 1300 : 0) +
                (index % 23 === 0 ? 8500 : 0)
            )
            const inputTokens = 650 + ((index * 53) % 3000)
            const outputTokens = 180 + ((index * 19) % 900)
            const cached = index % 3 === 0 ? Math.floor(inputTokens * 0.65) : 0
            const inputCost = inputTokens * 0.000001 * profile.rate
            const outputCost = outputTokens * 0.000004 * profile.rate
            const cost = inputCost + outputCost
            const attributes = {
              synthetic: true,
              "demo.fixture": "reports-demo-v1",
              "demo.candidate": profile.label,
              "model.id": profile.model,
              "gen_ai.request.model": profile.model,
              "datool.prompt.id": promptId(o),
              "datool.prompt.slug": operation.slug,
              "datool.prompt.version": v + 1,
              "usage.input_tokens": inputTokens,
              "usage.output_tokens": outputTokens,
              "usage.cache_read_tokens": cached,
              "usage.cache_write_tokens": index % 4 === 0 ? 180 : 0,
              "cost.usd": cost,
              "cost.status": "calculated",
              "cost.breakdown": {
                inputUSD: inputCost,
                outputUSD: outputCost,
                cacheReadsUSD: cached * 0.0000001,
                cacheWritesUSD: 0,
              },
              "ttft.ms": Math.round(duration * (0.08 + noise * 0.1)),
            }
            const input = JSON.stringify({
              question: operation.question,
              dataset: datasets[d],
              variation: c + 1,
            })
            const output = JSON.stringify({
              answer: operation.answer,
              candidate: profile.label,
              synthetic: true,
            })
            const state = error ? "errored" : "completed"
            add("traces", {
              id: traceId,
              project_id: projectId,
              name: `${operation.name} · ${profile.label} · ${datasets[d]} #${c + 1}`,
              operation: operation.type,
              ...group,
              status: state,
              input_json: input,
              output_json: output,
              attributes_json: JSON.stringify(attributes),
              started_at: iso(timestamp),
              ended_at: iso(timestamp + duration + 140),
            })
            add("spans", {
              id: `${traceId}-retrieval`,
              project_id: projectId,
              trace_id: traceId,
              name: "Retrieve reference context",
              kind: "tool",
              status: "completed",
              input_json: input,
              output_json: JSON.stringify({
                documents: ["Returns policy", "Account recovery guide"],
                synthetic: true,
              }),
              attributes_json: metadata,
              started_at: iso(timestamp),
              ended_at: iso(timestamp + 140),
            })
            add("spans", {
              id: `${traceId}-llm`,
              project_id: projectId,
              trace_id: traceId,
              name: "Generate candidate answer",
              kind: "llm",
              ...group,
              status: state,
              input_json: input,
              output_json: output,
              attributes_json: JSON.stringify(attributes),
              started_at: iso(timestamp + 140),
              ended_at: iso(timestamp + 140 + duration),
            })
            add("eval_run_targets", {
              id: targetId,
              project_id: projectId,
              run_id: runId,
              trace_id: traceId,
              dataset_item_id: itemId(d, o, c),
              ordinal: c,
              stage: "completed",
              created_at: iso(timestamp),
              snapshot_json: JSON.stringify({
                targetId,
                datasetItem: {
                  id: itemId(d, o, c),
                  datasetId: datasetId(d),
                  input: JSON.parse(input),
                  expectedOutput: { answer: operation.answer },
                  metadata: { synthetic: true },
                },
                trace: {
                  id: traceId,
                  name: operation.name,
                  operation: operation.type,
                  input: JSON.parse(input),
                  output: JSON.parse(output),
                  attributes,
                  status: state,
                  startedAt: iso(timestamp),
                  endedAt: iso(timestamp + duration),
                  sessionId: null,
                  group: {
                    type: operation.type,
                    name: operation.name,
                    version: `v${v + 1}`,
                  },
                  spans: [
                    {
                      id: `${traceId}-llm`,
                      traceId,
                      parentId: null,
                      name: "Generate candidate answer",
                      kind: "llm",
                      input: JSON.parse(input),
                      output: JSON.parse(output),
                      attributes,
                      status: state,
                      startedAt: iso(timestamp + 140),
                      endedAt: iso(timestamp + duration + 140),
                    },
                  ],
                },
              }),
            })
            add("eval_target_attributions", {
              id: `${targetId}-attribution`,
              project_id: projectId,
              run_id: runId,
              target_id: targetId,
              ...group,
              models_json: JSON.stringify([profile.model]),
              source_trace_id: traceId,
              source_span_id: `${traceId}-llm`,
              prompt_versions_json: JSON.stringify(
                index % 97 === 0
                  ? []
                  : [{ id: promptId(o), slug: operation.slug, version: v + 1 }]
              ),
            })
            for (let s = 0; s < 3; s++) {
              const failed = error && s === 0
              if (failed) errors++
              const regression = v === 3 && d === 3 && s === 2 ? 0.28 : 0
              const score = failed
                ? null
                : Math.round(
                    Math.max(
                      0,
                      Math.min(
                        1,
                        profile.quality -
                          d * 0.045 -
                          s * 0.025 +
                          (noise - 0.5) * 0.24 +
                          (13 - day) * 0.003 -
                          regression
                      )
                    ) * 1000
                  ) / 1000
              const resultId = `${targetId}-result-${s}`
              add("eval_results", {
                id: resultId,
                project_id: projectId,
                run_id: runId,
                target_id: targetId,
                trace_id: traceId,
                dataset_item_id: itemId(d, o, c),
                evaluator_id: scorerId(s),
                evaluator_version_id: `${scorerId(s)}-v1`,
                score,
                passed: score === null ? null : score >= 0.75,
                status: failed ? "error" : "completed",
                reasoning: failed
                  ? null
                  : `Synthetic ${scorerNames[s].toLowerCase()} assessment for ${profile.label}; ${score! >= 0.75 ? "meets" : "below"} the 0.75 threshold.`,
                error: failed ? "Synthetic scorer timeout" : null,
                metadata_json: metadata,
                created_at: iso(timestamp + duration),
                completed_at: iso(timestamp + duration + 600),
              })
              add("scores", {
                id: `${resultId}-score`,
                project_id: projectId,
                trace_id: traceId,
                eval_result_id: resultId,
                evaluator_id: scorerId(s),
                name: "score",
                value: score,
                status: failed ? "error" : "ok",
                created_at: iso(timestamp + duration + 600),
              })
            }
          }
          add("eval_runs", {
            id: runId,
            project_id: projectId,
            name: `${operation.name} · v${v + 1} ${profile.label} · ${datasets[d]}`,
            dataset_id: datasetId(d),
            status: errors ? "partial" : "completed",
            metadata_json: metadata,
            created_at: iso(started),
            completed_at: iso(started + 6 * 60000),
            groups_resolved_at: iso(started + 6 * 60000),
          })
        }
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    for (const table of [
      "managed_prompts",
      "managed_prompt_versions",
      "evaluators",
      "evaluator_versions",
      "scorers",
      "datasets",
      "dataset_items",
      "traces",
      "spans",
      "eval_runs",
      "eval_run_groups",
      "eval_run_evaluators",
      "eval_run_targets",
      "eval_target_attributions",
      "eval_results",
      "scores",
    ])
      await insert(client, table, rows.get(table)!)
    await client.query("COMMIT")
    // Fresh bulk inserts need planner statistics before analytical capture.
    for (const table of rows.keys()) await client.query(`ANALYZE "${table}"`)
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
  const db = createTracerDatabase(databaseUrl, { projectId })
  try {
    const dashboards = createDashboardService(db)
    const reports = createReportService(db)
    const existingDashboards = await run(dashboards.list())
    const existingReports = await run(reports.list())
    for (const template of reportTemplates) {
      const config = template.create()
      config.name = `Demo / ${template.name}`
      config.description =
        "Synthetic report exploration data: 14 days, 3 operations, 15 prompt versions, 4 datasets and 3 scorers."
      config.widgets = [
        {
          id: "demo-notes",
          type: "text",
          title: "Demo notes",
          width: 3,
          content: `## ${template.name}\n\nSynthetic demo data across **three operations**, **five prompt candidates** and **four datasets**. Compare quality, cost and response times.\n\n- **v3 Grounded** balances correctness and cost.\n- **v4 Reasoning** has stronger average scores but a safety regression on adversarial cases.\n- **v5 Efficient** reduces cost and latency with a small quality tradeoff.`,
        },
        ...config.widgets.filter((widget) => widget.type !== "text"),
      ]
      if (!existingDashboards.some((item) => item.name === config.name)) {
        const dashboard = await run(dashboards.create(config))
        console.log(`Dashboard: /p/${projectSlug}/dashboards/${dashboard.id}`)
      }
      if (!existingReports.some((item) => item.name === config.name)) {
        const report = await run(
          reports.create({
            ...dashboardReportDocument(config),
            creationKey: crypto.randomUUID(),
          })
        )
        console.log(`Report: /p/${projectSlug}/reports/${report.number}`)
      }
    }
  } finally {
    await closeTracerDatabase(db)
  }
  console.log(
    `Seed complete for ${projectSlug}: ${index} traces and ${index * 3} scored results.`
  )
} finally {
  await pool.end()
}
