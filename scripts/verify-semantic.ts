import { Pool, type PoolClient } from "pg"

type JsonRecord = Record<string, unknown>

const baseUrl = process.env.DATOOL_SEMANTIC_BASE_URL ?? "http://127.0.0.1:3000"
const projectId = process.env.DATOOL_PROJECT_ID
const databaseUrl = process.env.DATABASE_URL
if (!projectId) {
  throw new Error("DATOOL_PROJECT_ID is required to verify one project-scoped semantic workspace.")
}
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to verify the PostgreSQL semantic oracle.")
}
const apiHeaders = {
  "content-type": "application/json",
  "x-project-id": projectId,
  ...(process.env.DATOOL_API_KEY ? { authorization: `Bearer ${process.env.DATOOL_API_KEY}` } : {}),
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function assertEqual(actual: unknown, expected: unknown, description: string) {
  if (stable(actual) !== stable(expected)) {
    throw new Error(`${description} differed.\nexpected: ${stable(expected)}\nactual:   ${stable(actual)}`)
  }
}

function asNumber(value: unknown, name: string) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${name} was not a finite number.`)
  return number
}

function asText(value: unknown, name: string) {
  if (typeof value !== "string") throw new Error(`${name} was not text.`)
  return value
}

async function withReadOnlyDatabase<Value>(callback: (client: PoolClient) => Promise<Value>): Promise<Value> {
  const pool = new Pool({ connectionString: databaseUrl })
  const client = await pool.connect()
  let began = false
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
    began = true
    await client.query("SELECT 1")
    return await callback(client)
  } finally {
    try {
      if (began) await client.query("ROLLBACK")
    } finally {
      client.release()
      await pool.end()
    }
  }
}

async function getJson(path: string) {
  const response = await fetch(`${baseUrl}${path}`, { headers: apiHeaders })
  const body = (await response.json()) as JsonRecord
  return { body, response }
}

async function postJson(path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    body: JSON.stringify(body),
    headers: apiHeaders,
    method: "POST",
  })
  return { body: (await response.json()) as JsonRecord, response }
}

async function postInvalidJson(path: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    body: "{",
    headers: apiHeaders,
    method: "POST",
  })
  return { body: (await response.json()) as JsonRecord, response }
}

type TraceOracleRow = Readonly<{
  "traces.count": number
  "traces.startedAt": string
  "traces.status": string
}>

type LegacyMetric = Readonly<{
  count: number
  error: string | null
  name: "meanScore" | "passRate" | "scoredCount"
  status: "empty" | "error" | "ok"
  value: number | null
}>

async function verify() {
  const result = await withReadOnlyDatabase(async (client) => {
    const traceRows = (await client.query(
      "SELECT status, started_at FROM traces WHERE project_id = $1",
      [projectId],
    )).rows
    const validTraces = traceRows
      .map((row) => ({ startedAt: asText(row.started_at, "traces.started_at"), status: asText(row.status, "traces.status") }))
      .map((row) => ({ ...row, instant: Date.parse(row.startedAt) }))
      .filter((row) => Number.isFinite(row.instant))
    if (!validTraces.length) throw new Error("The existing local database has no valid trace timestamps to verify.")

    const latest = Math.max(...validTraces.map((row) => row.instant))
    const earliest = Math.min(...validTraces.map((row) => row.instant))
    const to = new Date(latest + 1)
    const from = new Date(Math.max(earliest, to.getTime() - 90 * 86_400_000))
    const groups = new Map<string, TraceOracleRow>()
    for (const row of validTraces) {
      if (row.instant < from.getTime() || row.instant >= to.getTime()) continue
      const day = new Date(row.instant).toISOString().slice(0, 10)
      const key = `${day}\u0000${row.status}`
      const current = groups.get(key)
      groups.set(key, {
        "traces.count": (current?.["traces.count"] ?? 0) + 1,
        "traces.startedAt": day,
        "traces.status": row.status,
      })
    }
    const expectedTraceRows = [...groups.values()].sort(
      (left, right) =>
        left["traces.startedAt"].localeCompare(right["traces.startedAt"]) ||
        left["traces.status"].localeCompare(right["traces.status"]),
    )

    const legacyRows = (await client.query(
      `SELECT eval_results.passed AS passed, scores.status AS score_status, scores.value AS value
       FROM scores
       INNER JOIN eval_results
         ON eval_results.project_id = scores.project_id
        AND eval_results.id = scores.eval_result_id
       WHERE scores.project_id = $1`,
      [projectId],
    )).rows
    const numericScores = legacyRows
      .filter((row) => row.score_status === "ok" && row.value !== null)
      .map((row) => asNumber(row.value, "scores.value"))
    const explicitPasses = legacyRows
      .filter((row) => row.passed !== null)
      .map((row) => Boolean(row.passed))
    const errorCount = legacyRows.filter((row) => row.score_status === "error").length
    const noValueStatus = errorCount > 0 ? "error" : "empty"
    const noValueError = errorCount > 0 ? `${errorCount} evaluator result(s) ended in an error.` : null
    const mean = numericScores.length
      ? numericScores.reduce((sum, value) => sum + value, 0) / numericScores.length
      : null
    const passRate = explicitPasses.length
      ? explicitPasses.filter(Boolean).length / explicitPasses.length
      : null
    const expectedLegacy: Readonly<{ metrics: readonly LegacyMetric[]; scope: "traces" }> = {
      metrics: [
        {
          count: numericScores.length,
          error: mean === null ? noValueError : null,
          name: "meanScore",
          status: mean === null ? noValueStatus : "ok",
          value: mean,
        },
        {
          count: explicitPasses.length,
          error: passRate === null ? noValueError : null,
          name: "passRate",
          status: passRate === null ? noValueStatus : "ok",
          value: passRate,
        },
        {
          count: numericScores.length,
          error: numericScores.length === 0 ? noValueError : null,
          name: "scoredCount",
          status: numericScores.length === 0 ? noValueStatus : "ok",
          value: numericScores.length === 0 ? null : numericScores.length,
        },
      ],
      scope: "traces",
    }

    return { expectedLegacy, expectedTraceRows, from: from.toISOString(), to: to.toISOString() }
  })

  const metadata = await getJson("/api/metrics/meta")
  if (metadata.response.status !== 200) throw new Error(`Metadata returned HTTP ${metadata.response.status}.`)
  const models = ((metadata.body.data as JsonRecord | undefined)?.models as JsonRecord[] | undefined) ?? []
  assertEqual(
    models.map((model) => model.name),
    ["agents", "evalRuns", "scores", "traces", "workflows"],
    "Semantic metadata model order",
  )

  const query = {
    dimensions: ["traces.status"],
    measures: ["traces.count"],
    order: [
      ["traces.startedAt", "asc"],
      ["traces.status", "asc"],
    ],
    timeDimensions: [
      {
        dateRange: [result.from, result.to],
        dimension: "traces.startedAt",
        granularity: "day",
      },
    ],
    timezone: "UTC",
    total: true,
  }
  const semantic = await postJson("/api/metrics/query", query)
  if (semantic.response.status !== 200) throw new Error(`Semantic trace query returned HTTP ${semantic.response.status}.`)
  const semanticData = semantic.body.data as JsonRecord
  assertEqual(semanticData.data, result.expectedTraceRows, "Semantic trace rows against raw PostgreSQL oracle")
  const page = (semanticData.meta as JsonRecord).page as JsonRecord
  assertEqual(page.total, result.expectedTraceRows.length, "Semantic pre-page grouped total")

  const legacy = await getJson("/api/metrics?scope=traces")
  if (legacy.response.status !== 200) throw new Error(`Legacy metrics returned HTTP ${legacy.response.status}.`)
  assertEqual(legacy.body.data, result.expectedLegacy, "Legacy metrics response against raw SQLite oracle")

  const malformed = await postInvalidJson("/api/metrics/query")
  if (malformed.response.status !== 400 || (malformed.body.error as JsonRecord | undefined)?.code !== "VALIDATION_ERROR") {
    throw new Error("Malformed JSON did not return the expected HTTP 400 VALIDATION_ERROR envelope.")
  }
  const invalid = await postJson("/api/metrics/query", { measures: [] })
  const invalidError = invalid.body.error as JsonRecord | undefined
  if (
    invalid.response.status !== 400 ||
    invalidError?.code !== "VALIDATION_ERROR" ||
    (invalidError.details as JsonRecord | undefined)?.semanticCode !== "INVALID_QUERY"
  ) {
    throw new Error("Invalid semantic query did not return HTTP 400 VALIDATION_ERROR with semanticCode INVALID_QUERY.")
  }

  return {
    legacyMetricRows: result.expectedLegacy.metrics.length,
    metadataModels: models.map((model) => model.name),
    semanticGroups: result.expectedTraceRows.length,
    traceFacts: result.expectedTraceRows.reduce((sum, row) => sum + row["traces.count"], 0),
    window: [result.from, result.to],
  }
}

try {
  console.log(JSON.stringify(await verify(), null, 2))
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
