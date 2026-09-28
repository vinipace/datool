import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "bun:test"
import { findAgentOperation } from "../src/server/mcp/operations"
import { scorerInputSchema } from "../src/lib/tracer/scorers"
import type { TraceForEvaluation, JsonValue } from "../src/lib/tracer/contracts"
import { runEvaluator } from "../src/server/sandbox/evaluator"
import { parseCreateEvalRun } from "../src/server/tracer/validation"
import { validateSemanticQuery } from "../src/server/semantic/executor"
import { semanticCatalog } from "../src/server/metrics/registry"

async function fixture(path: string) {
  return JSON.parse(
    await readFile(
      new URL(`./fixtures/agent-operations/${path}`, import.meta.url),
      "utf8"
    )
  )
}

test("agent operation fixtures conform to the shared operation contracts", async () => {
  const cases = [
    ["exact-json.json", "create_scorer", {}],
    ["bulk-create.json", "bulk_dataset_items", { datasetId: "dataset-id" }],
    ["connected-run.json", "start_eval_run", {}],
    ["input-overrides-run.json", "start_eval_run", {}],
    ["rescore.json", "start_eval_run", {}],
    ["gate.json", "gate_eval_run", {}],
    ["trace-count.json", "query_metrics", {}],
    ["spans-cost-by-model.json", "query_metrics", {}],
    ["scores-by-definition.json", "query_metrics", {}],
    ["five-source-counts.json", "batch_metrics", {}],
    ["evaluation-report.json", "create_report", {}],
  ] as const
  for (const [path, name, positional] of cases) {
    const input = { ...(await fixture(path)), ...positional }
    const operation = findAgentOperation(name)
    assert(operation)
    assert(
      operation.schema.strict().safeParse(input).success,
      `${path}: invalid ${name} input`
    )
    if (name === "query_metrics")
      validateSemanticQuery(input.query, semanticCatalog)
    if (name === "batch_metrics")
      for (const query of input.queries)
        validateSemanticQuery(query, semanticCatalog)
    if (name === "create_report")
      for (const source of Object.values(input.sources) as {
        query: Parameters<typeof validateSemanticQuery>[0]
      }[])
        validateSemanticQuery(source.query, semanticCatalog)
    if (name === "start_eval_run") {
      const options = Object.fromEntries(
        Object.entries(input).filter(([key]) => key !== "requestKey")
      )
      assert(parseCreateEvalRun(options))
    }
  }
})

test("exact JSON example scorer handles nested key order, mismatches, arrays and absent context in the real sandbox", async () => {
  const scorer = scorerInputSchema.parse(
    (await fixture("exact-json.json")).scorer
  )
  const trace: TraceForEvaluation = {
    id: "trace",
    name: "Operation fixture check",
    operation: "test",
    sessionId: null,
    status: "completed",
    input: null,
    output: null,
    attributes: {},
    spans: [],
    startedAt: "2026-09-11T00:00:00.000Z",
    endedAt: "2026-09-11T00:00:01.000Z",
  }
  const samples: [JsonValue, JsonValue, boolean][] = [
    [{ b: { y: 2, x: 1 }, a: [1, 2] }, { a: [1, 2], b: { x: 1, y: 2 } }, true],
    [{ answer: 4 }, { answer: 5 }, false],
    [[1, 2], [2, 1], false],
    [null, null, true],
  ]
  for (const [output, expectedOutput, passed] of samples) {
    const result = await runEvaluator({
      code: scorer.code,
      trace: { ...trace, output },
      datasetItem: {
        id: "item",
        datasetId: "dataset",
        input: null,
        expectedOutput,
        metadata: {},
        sourceTraceId: null,
      },
    })
    assert.equal(result.error, undefined)
    assert.equal(result.passed, passed)
    assert.equal(result.score, passed ? 1 : 0)
  }
  const missing = await runEvaluator({ code: scorer.code, trace })
  assert(missing.error)
  assert.equal(missing.score, null)
  assert.equal(missing.passed, null)
})
