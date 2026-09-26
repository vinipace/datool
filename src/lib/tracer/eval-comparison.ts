import type { EvalRunDetail, JsonValue } from "./contracts"

export type EvalComparisonRow = NonNullable<EvalRunDetail["rows"]>[number]
export type EvalPair = {
  id: string
  left?: EvalComparisonRow
  right?: EvalComparisonRow
  matchedBy?: "dataset item" | "trace" | "input"
  inputChanged?: boolean
  referenceChanged?: boolean
}

/** Errored and skipped scoring attempts are not numeric observations. A failed score still is. */
export function comparableScore(result: EvalComparisonRow["results"][number] | undefined): number | null {
  return result && !result.error && result.metadata.skipped !== true &&
    ["completed", "passed", "failed"].includes(result.status) &&
    result.score != null && Number.isFinite(result.score)
    ? result.score : null
}

export function averageEvalScore(row: EvalComparisonRow | undefined): number | null {
  const scores = row?.results.flatMap(result => {
    const score = comparableScore(result)
    return score == null ? [] : [score]
  }) ?? []
  return scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null
}

function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
      .join(",")}}`
  return JSON.stringify(value)
}

/** Match only unique keys at each stage; never zip unrelated or ambiguous rows. */
export function pairEvalRows(
  left: EvalComparisonRow[],
  right: EvalComparisonRow[]
): EvalPair[] {
  const pairs = new Map<string, EvalPair>()
  const usedRight = new Set<string>()
  const stages: [
    EvalPair["matchedBy"],
    (row: EvalComparisonRow) => string | null,
  ][] = [
    ["dataset item", (row) => row.datasetCaseId ?? row.datasetItemId],
    ["trace", (row) => row.trace.id],
    [
      "input",
      (row) =>
        row.trace.input == null || row.trace.input === ""
          ? null
          : canonical(row.trace.input),
    ],
  ]
  for (const [matchedBy, key] of stages) {
    const groups = (rows: EvalComparisonRow[]) => {
      const result = new Map<string, EvalComparisonRow[]>()
      for (const row of rows) {
        const value = key(row)
        if (value !== null)
          result.set(value, [...(result.get(value) ?? []), row])
      }
      return result
    }
    const l = groups(left.filter((row) => !pairs.has(row.id)))
    const r = groups(right.filter((row) => !usedRight.has(row.id)))
    for (const [value, candidates] of l) {
      const other = r.get(value)
      if (candidates.length !== 1 || other?.length !== 1) continue
      const row = candidates[0]
      pairs.set(row.id, {
        id: `left:${row.id}`,
        left: row,
        right: other[0],
        matchedBy,
      })
      usedRight.add(other[0].id)
    }
  }
  return [
    ...left.map(
      (row) => pairs.get(row.id) ?? { id: `left:${row.id}`, left: row }
    ),
    ...right
      .filter((row) => !usedRight.has(row.id))
      .map((row) => ({ id: `right:${row.id}`, right: row })),
  ]
}

export function parseCompareIds(value: string | null): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    ),
  ]
}

export function evalComparisonUrl(ids: string[], search = ""): string {
  const query = new URLSearchParams(search)
  query.delete("compare")
  const rest = query.toString()
  return `/evals?compare=${[...new Set(ids)].map(encodeURIComponent).join(",")}${rest ? `&${rest}` : ""}`
}

export type RunConfigurationChange = {
  kind: "extractor" | "judge"
  field: string
  before: JsonValue
  after: JsonValue
}
export function evalConfigurationChanges(
  left: Pick<EvalRunDetail, "metadata" | "evaluatorVersionIds">,
  right: Pick<EvalRunDetail, "metadata" | "evaluatorVersionIds">
): RunConfigurationChange[] {
  const changes: RunConfigurationChange[] = []
  const compare = (
    kind: RunConfigurationChange["kind"],
    field: string,
    before: JsonValue = null,
    after: JsonValue = null
  ) => {
    if (canonical(before) !== canonical(after))
      changes.push({ kind, field, before, after })
  }
  compare(
    "extractor",
    "app",
    left.metadata.app ?? left.metadata.sourceApp,
    right.metadata.app ?? right.metadata.sourceApp
  )
  const prompts = (run: typeof left) =>
    (
      run.metadata.promptConfig as
        { prompts?: Record<string, JsonValue> } | undefined
    )?.prompts ?? {}
  const a = prompts(left),
    b = prompts(right)
  for (const slug of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const resolved = (value: JsonValue | undefined) => {
      const p = value as
        { id?: string; version?: number; model?: string } | undefined
      return p
        ? {
            id: p.id ?? null,
            version: p.version ?? null,
            model: p.model ?? null,
          }
        : null
    }
    compare("extractor", `prompt:${slug}`, resolved(a[slug]), resolved(b[slug]))
  }
  compare(
    "extractor",
    "inputOverrides",
    left.metadata.inputOverrides ?? {},
    right.metadata.inputOverrides ?? {}
  )
  for (const id of new Set([
    ...Object.keys(left.evaluatorVersionIds ?? {}),
    ...Object.keys(right.evaluatorVersionIds ?? {}),
  ]))
    compare(
      "judge",
      `scorer:${id}`,
      left.evaluatorVersionIds?.[id],
      right.evaluatorVersionIds?.[id]
    )
  return changes
}
