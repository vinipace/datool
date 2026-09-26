import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { EvalResult } from "@/src/lib/tracer/contracts"
import { ComputedColumnDetails, ComputedValue } from "@/components/tracer/eval-computed-columns"
import { EvalScoreCell, ScoreExplanation } from "@/components/tracer/eval-score-cell"

const result: EvalResult = { id: "r", runId: "run", traceId: "trace", evaluatorId: "score", evaluatorName: "Quality", evaluatorVersion: 1, completedAt: null, datasetItemId: null, error: null, metadata: {}, passed: null, reasoning: null, score: 0, status: "completed" }
test("score cells distinguish zero, missing, boolean and failed evaluations", () => {
  expect(renderToStaticMarkup(<EvalScoreCell result={result} />)).toContain("0%")
  expect(renderToStaticMarkup(<EvalScoreCell />)).toContain("—")
  expect(renderToStaticMarkup(<EvalScoreCell result={{ ...result, metadata: { booleanScore: false } }} />)).toContain('aria-label="Failed"')
  const error = renderToStaticMarkup(<EvalScoreCell result={{ ...result, error: "Timed out", status: "error" }} />)
  expect(error).toContain('title="Timed out"')
  expect(error).not.toContain("0%")
})


test("inspector scores share the table percentage renderer", () => {
  const markup = renderToStaticMarkup(<EvalScoreCell result={{ score: 1, status: "completed" }} />)
  expect(markup).toContain("100%")
  expect(markup).toContain("bg-score-fill")
  expect(renderToStaticMarkup(<EvalScoreCell result={{ score: null, status: "error" }} />)).toContain("Error")
})


test("inspector custom fields reuse computed values including zero", () => {
  const markup = renderToStaticMarkup(<ComputedColumnDetails onRemove={() => {}} columns={[{ id: "c", name: "Custom total", mode: "expression", code: "0" }]} cells={{ c: { trace: { value: "0" } } }} rowId="trace" />)
  expect(markup).toContain("Custom total")
  expect(markup).toContain(">0</span>")
})


test("computed Markdown renders structure while text stays literal", () => {
  const cell = { value: "### Output\n\n**Formatted**" }
  expect(renderToStaticMarkup(<ComputedValue cell={cell} format="markdown" />)).toContain("<strong>Formatted</strong>")
  expect(renderToStaticMarkup(<ComputedValue cell={cell} />)).toContain("**Formatted**")
})

test("score explanation shows a compact score and reasoning with the scorer span icon", () => {
  const markup = renderToStaticMarkup(<ScoreExplanation result={{ ...result, evaluatorVersion: 3, reasoning: "Expected brands matched", definition: { id: "v3", evaluatorId: "score", version: 3, createdAt: "2026-09-09", language: "javascript", code: "function evaluate() { return { score: 1 }; }" } }} />)
  expect(markup).toContain("0%")
  expect(markup).toContain('aria-label="score"')
  expect(markup).toContain("Expected brands matched")
  expect(markup).not.toContain("Version 3")
  expect(markup).not.toContain("function evaluate()")
})
