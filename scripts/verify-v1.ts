/**
 * Black-box acceptance verifier for the local Datool v1 server.
 *
 * Start `bun run dev` first, then run this script against the same server.
 * It deliberately exercises public HTTP contracts rather than importing
 * services, so it catches wiring, persistence, and sandbox regressions.
 */

type RecordValue = Record<string, unknown>

type Demo = {
  datasetId: string
  evaluatorId: string
  evalRunId: string
  sessionId: string
  traceIds: string[]
  viewId: string
}

type TraceDetail = {
  id: string
  sessionId: string | null
  spans: Array<{ id: string; parentId: string | null }>
}

type DatasetDetail = {
  id: string
  items: Array<{ id: string; sourceTraceId: string | null }>
}

type EvalResult = {
  error: string | null
  evaluatorId: string
  evaluatorVersion: number
  id: string
  passed: boolean | null
  score: number | null
  status: string
  traceId: string
}

type EvalRunDetail = {
  datasetItemIds: string[]
  id: string
  results: EvalResult[]
  status: string
  traceIds: string[]
  rows: { trace: { id: string } }[]
}

type SavedViewData = {
  columns: Array<{ id: string; selector: string }>
  rows: Array<{ id: string; values: RecordValue }>
}

const baseUrl = (
  process.env.DATOOL_BASE_URL ?? "http://127.0.0.1:3000"
).replace(/\/$/, "")
const runToken = `qa-${Date.now().toString(36)}`
// A production image has no implicit Docker daemon access. Its acceptance
// test verifies that code cannot fall back to the host process in that state.
const sandboxUnavailable = process.env.DATOOL_VERIFY_SANDBOX_UNAVAILABLE === "1"
const projectId = requiredEnvironment("DATOOL_PROJECT_ID")
const apiHeaders = {
  "content-type": "application/json",
  authorization: `Bearer ${requiredEnvironment("DATOOL_API_KEY")}`,
  "x-project-id": projectId,
}

function requiredEnvironment(name: "DATOOL_API_KEY" | "DATOOL_PROJECT_ID") {
  const value = process.env[name]?.trim()
  if (!value)
    throw new Error(
      `${name} is required for a project-scoped v1 verification run.`
    )
  return value
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

function assertSandboxUnavailable(result: EvalResult) {
  assert(
    result.status === "error" &&
      result.score === null &&
      result.passed === null,
    "Unconfigured sandbox must persist an error with no score"
  )
  assert(
    result.error?.includes("No sandbox provider is available"),
    `Expected sandbox configuration failure: ${result.error}`
  )
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function describe(value: unknown) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

async function responseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? ""

  if (contentType.includes("application/json")) {
    return response.json()
  }

  return response.text()
}

async function request(method: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: apiHeaders,
    method,
  })

  return { body: await responseBody(response), response }
}

async function api<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const result = await request(method, path, body)

  if (
    !result.response.ok ||
    !isRecord(result.body) ||
    !("data" in result.body)
  ) {
    throw new Error(
      `${method} ${path} failed with ${result.response.status}: ${describe(result.body)}`
    )
  }

  return result.body.data as T
}

async function expectApiError(method: string, path: string, body?: unknown) {
  const result = await request(method, path, body)
  assert(!result.response.ok, `${method} ${path} unexpectedly succeeded`)
  assert(
    isRecord(result.body) && isRecord(result.body.error),
    `${method} ${path} did not return an API error envelope`
  )
  assert(
    typeof result.body.error.code === "string",
    `${method} ${path} error had no code`
  )

  return result.body.error
}

async function waitForRun(runId: string): Promise<EvalRunDetail> {
  const deadline = Date.now() + 15_000

  while (Date.now() < deadline) {
    const run = await api<EvalRunDetail>(
      "GET",
      `/api/evals/${encodeURIComponent(runId)}`
    )
    if (run.status !== "running") {
      return run
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`Eval run ${runId} did not finish within 15 seconds`)
}

function mean(values: number[]) {
  return values.reduce((total, value) => total + value, 0) / values.length
}

async function createEvaluator(name: string, code: string) {
  return api<{ id: string }>("POST", "/api/evaluators", {
    code,
    language: "javascript",
    name,
  })
}

async function evaluateOne(evaluatorId: string, traceId: string) {
  const run = await api<{ id: string }>("POST", "/api/evals", {
    evaluatorIds: [evaluatorId],
    name: `${runToken} evaluator check`,
    traceIds: [traceId],
  })

  const detail = await waitForRun(run.id)
  const result = detail.results.find(
    (candidate) => candidate.evaluatorId === evaluatorId
  )
  assert(
    result,
    `Eval run ${run.id} has no result for evaluator ${evaluatorId}`
  )
  return { result, run: detail }
}

async function expectSandboxFailure(
  name: string,
  code: string,
  traceId: string
) {
  const evaluator = await createEvaluator(`${runToken} ${name}`, code)
  const { result, run } = await evaluateOne(evaluator.id, traceId)

  assert(
    run.status === "failed" || run.status === "partial",
    `${name} run should not be completed: ${run.status}`
  )
  assert(
    result.status === "error",
    `${name} should persist an error result: ${result.status}`
  )
  assert(
    result.score === null,
    `${name} error score must be null, not a numeric fallback`
  )
  assert(result.passed === null, `${name} error passed state must be null`)
  assert(
    typeof result.error === "string" && result.error.length > 0,
    `${name} must retain an error message`
  )

  return { evaluatorId: evaluator.id, resultId: result.id, runId: run.id }
}

async function main() {
  const created = await api<Demo>("POST", "/api/demo")
  assert(created.traceIds.length > 0, "Demo did not return a trace")

  const trace = await api<TraceDetail>(
    "GET",
    `/api/traces/${encodeURIComponent(created.traceIds[0])}`
  )
  assert(
    trace.id === created.traceIds[0],
    "Demo trace lookup returned the wrong trace"
  )
  assert(
    trace.sessionId === created.sessionId,
    "Demo trace is not linked to its returned session"
  )
  assert(
    trace.spans.length >= 2,
    "Demo trace must contain nested workflow spans"
  )
  assert(
    trace.spans.some((span) => span.parentId !== null),
    "Demo spans do not form a parent/child graph"
  )

  const session = await api<{ id: string; traces: Array<{ id: string }> }>(
    "GET",
    `/api/sessions/${encodeURIComponent(created.sessionId)}`
  )
  assert(
    session.traces.some((candidate) => candidate.id === trace.id),
    "Session does not expose its demo trace"
  )

  const dataset = await api<DatasetDetail>(
    "GET",
    `/api/datasets/${encodeURIComponent(created.datasetId)}`
  )
  assert(dataset.items.length > 0, "Demo dataset has no items")
  assert(
    dataset.items.some((item) => item.sourceTraceId === trace.id),
    "Demo dataset item is not linked to its source trace"
  )

  const demoRun = await waitForRun(created.evalRunId)
  assert(demoRun.results.length > 0, "Demo eval run has no persisted results")
  const demoResult = demoRun.results.find(
    (result) => result.traceId === trace.id
  )
  assert(demoResult, "Demo eval result is not linked to the demo trace")
  if (sandboxUnavailable) assertSandboxUnavailable(demoResult)
  else {
    assert(
      typeof demoResult.score === "number" && Number.isFinite(demoResult.score),
      "Demo eval result has no finite score"
    )
    assert(
      demoResult.score >= 0 && demoResult.score <= 1,
      "Demo eval score is outside 0..1"
    )
  }

  const customView = await api<SavedViewData>(
    "GET",
    `/api/views/${encodeURIComponent(created.viewId)}/data?runId=${encodeURIComponent(created.evalRunId)}`
  )
  assert(
    customView.rows.length === demoRun.results.length,
    "Demo saved view is not scoped to its eval run"
  )
  assert(
    customView.columns.some(
      (column) => column.selector === "trace.output.answer.text"
    ),
    "Demo saved view does not select the narrow trace output field"
  )
  assert(
    customView.columns.every((column) => column.selector !== "trace.output"),
    "Demo saved view exposes the entire trace output instead of a selected field"
  )

  const metrics = await api<{ data: Record<string, number | null>[] }>(
    "POST",
    "/api/metrics/query",
    {
      measures: ["scores.meanScore", "scores.scoredCount"],
      filters: [
        {
          member: "scores.evalRunId",
          operator: "equals",
          values: [created.evalRunId],
        },
      ],
      timeDimensions: [
        {
          dimension: "scores.completedAt",
          dateRange: [
            new Date(Date.now() - 86400000).toISOString(),
            new Date(Date.now() + 1000).toISOString(),
          ],
        },
      ],
    }
  )
  const scored = demoRun.results.flatMap((result) =>
    typeof result.score === "number" ? [result.score] : []
  )
  assert(
    metrics.data[0]?.["scores.scoredCount"] === scored.length,
    "Semantic count does not match persisted results"
  )
  assert(
    scored.length === 0
      ? metrics.data[0]?.["scores.meanScore"] === null
      : Math.abs(Number(metrics.data[0]?.["scores.meanScore"]) - mean(scored)) <
          0.000001,
    "Semantic mean does not match persisted results"
  )

  const successEvaluator = await createEvaluator(
    `${runToken} success`,
    `function evaluate({ trace }) {\n  const passed = Boolean(trace.output);\n  return { score: passed ? 1 : 0, passed, reason: passed ? "trace has output" : "trace has no output", metrics: { hasOutput: passed ? 1 : 0 } };\n}`
  )
  const success = await evaluateOne(successEvaluator.id, trace.id)
  if (sandboxUnavailable) assertSandboxUnavailable(success.result)
  else {
    assert(
      success.run.status === "completed",
      `Successful evaluator run did not complete: ${success.run.status}`
    )
    assert(
      typeof success.result.score === "number",
      "Successful evaluator result did not persist a score"
    )
    assert(
      success.result.error === null,
      "Successful evaluator result unexpectedly has an error"
    )
  }
  assert(
    success.run.rows.some((row) => row.trace.id === trace.id),
    "Eval run did not durably snapshot its selected trace target"
  )
  assert(
    success.result.evaluatorVersion === 1,
    "First evaluator run must retain evaluator version 1"
  )

  const updatedEvaluator = await api<{ activeVersion: { version: number } }>(
    "PATCH",
    `/api/evaluators/${encodeURIComponent(successEvaluator.id)}`,
    {
      code: `function evaluate({ trace }) {\n  const passed = Boolean(trace.output);\n  return { score: passed ? 1 : 0, passed, reason: "updated evaluator source" };\n}`,
    }
  )
  assert(
    updatedEvaluator.activeVersion.version === 2,
    "Editing evaluator code did not create version 2"
  )

  const historicalSuccess = await api<EvalRunDetail>(
    "GET",
    `/api/evals/${encodeURIComponent(success.run.id)}`
  )
  const historicalResult = historicalSuccess.results.find(
    (candidate) => candidate.id === success.result.id
  )
  assert(
    historicalResult?.evaluatorVersion === 1,
    "Existing eval result did not retain evaluator version 1"
  )

  const updatedSuccess = await evaluateOne(successEvaluator.id, trace.id)
  assert(
    updatedSuccess.result.evaluatorVersion === 2,
    "Updated evaluator run did not use evaluator version 2"
  )

  const malformed = await expectSandboxFailure(
    "malformed result",
    "function evaluate() { return { score: 2 }; }",
    trace.id
  )
  const syntax = await expectSandboxFailure(
    "syntax invalid",
    "function evaluate( { return { score: 1 }",
    trace.id
  )
  const thrown = await expectSandboxFailure(
    "thrown evaluator",
    'function evaluate() { throw new Error("intentional evaluator failure"); }',
    trace.id
  )
  const timeout = await expectSandboxFailure(
    "synchronous timeout",
    "function evaluate() { while (true) {} }",
    trace.id
  )

  await expectApiError(
    "POST",
    `/api/datasets/${runToken}-missing-dataset/items`,
    {
      input: { question: "missing parent dataset" },
    }
  )
  await expectApiError("POST", "/api/evals", {
    evaluatorIds: [successEvaluator.id],
    traceIds: [`${runToken}-missing-trace`],
  })
  await expectApiError("POST", "/api/evals", {
    datasetId: created.datasetId,
    datasetItemIds: [`${runToken}-missing-item`],
    evaluatorIds: [successEvaluator.id],
  })

  const malformedJsonResponse = await fetch(`${baseUrl}/api/datasets`, {
    body: "{",
    headers: apiHeaders,
    method: "POST",
  })
  const malformedJsonBody = await responseBody(malformedJsonResponse)
  assert(
    malformedJsonResponse.status === 400,
    "Malformed JSON must return HTTP 400"
  )
  assert(
    isRecord(malformedJsonBody) && isRecord(malformedJsonBody.error),
    "Malformed JSON did not return an API error envelope"
  )

  const savedView = await api<{ id: string }>("POST", "/api/views", {
    columns: [
      {
        format: "number",
        id: "score",
        label: "Score",
        selector: "result.score",
      },
      {
        format: "text",
        id: "missing-output",
        label: "Missing output",
        selector: "trace.output.notPresent",
      },
    ],
    name: `${runToken} persisted custom view`,
    resource: "eval-results",
  })
  const savedData = await api<SavedViewData>(
    "GET",
    `/api/views/${encodeURIComponent(savedView.id)}/data?runId=${encodeURIComponent(created.evalRunId)}`
  )
  assert(
    savedData.rows.length === demoRun.results.length,
    "Persisted custom view is not scoped to its eval run"
  )
  assert(
    savedData.columns.some((column) => column.id === "missing-output"),
    "Persisted custom view lost its selected column"
  )
  assert(
    savedData.rows.every((row) => Object.hasOwn(row.values, "missing-output")),
    "A missing valid selector broke custom-view row projection"
  )

  await expectApiError("POST", "/api/views", {
    columns: [
      {
        format: "text",
        id: "invalid",
        label: "Invalid",
        selector: "trace.output..answer",
      },
    ],
    name: `${runToken} invalid selector`,
    resource: "eval-results",
  })

  console.info(
    JSON.stringify(
      {
        demo: created,
        projectId,
        persistenceViewId: savedView.id,
        sandboxFailures: { malformed, syntax, thrown, timeout },
        sandboxMode: sandboxUnavailable
          ? "unconfigured-fails-closed"
          : "execution",
        successEvaluatorId: successEvaluator.id,
        verification: "passed",
      },
      null,
      2
    )
  )
}

await main()

export {}
