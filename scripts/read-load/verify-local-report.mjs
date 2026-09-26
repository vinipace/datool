import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

// Independent acceptance of the fixed 2M local fixture, not 1,000-user qualification.
const report = JSON.parse(readFileSync(process.argv[2], "utf8"))
const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 0.000001, `${actual} != ${expected}`)
assert.equal(report.coverage.traces, 2_000_000)
assert.equal(report.coverage.spans, 2_000_000)
assert.equal(report.coverage.seconds, 180)
assert.equal(report.coverage.arrivalRate, 5)
assert.equal(report.coverage.writeRate, 5)
assert.equal(report.baseline.length, 24)
for (const baseline of report.baseline) {
  assert.equal(baseline.status, 200, baseline.kind)
  const data = baseline.result.data
  if (!baseline.kind.startsWith("dashboard")) {
    assert.equal(data.items.length, 50)
    for (const row of data.items) {
      assert.equal(row.spanStats.spanCount, 1)
      if (["workflow-filter", "filtered-total"].includes(baseline.kind)) {
        assert.equal(row.group.type, "workflow")
        assert.equal(row.group.name, "Group 42")
      } else if (baseline.kind === "agent-version-filter") {
        assert.deepEqual(row.group, {
          type: "agent",
          name: "Group 42",
          version: "v1",
        })
      } else if (baseline.kind === "metadata-filter") {
        assert.equal(row.attributes.customer, "customer-42")
      }
    }
    if (baseline.kind === "filtered-total") assert.equal(data.total, 1000)
    if (baseline.kind === "broad-total") assert.equal(data.total, 2_000_000)
    continue
  }
  assert.equal(data.length, baseline.kind === "dashboard20" ? 20 : 4)
  for (const panel of data) {
    assert.equal(panel.meta.quality.status, "complete")
    const measure = panel.query.measures[0]
    const [model, key] = measure.split(".")
    const grouped = ["agents", "workflows"].includes(model)
    const dimensions = panel.query.dimensions
    if (dimensions.includes(`${model}.version`)) {
      assert.equal(panel.data.length, 3)
      for (const row of panel.data) {
        const extra = model === "agents" ? "v1" : "v2"
        assert.equal(
          row[measure],
          row[`${model}.version`] === extra ? 333334 : 333333
        )
      }
      assert.equal(
        panel.data.reduce((sum, row) => sum + row[measure], 0),
        1_000_000
      )
      continue
    }
    if (dimensions.includes(`${model}.name`))
      assert.equal(panel.data.length, 50)
    else assert.equal(panel.data.length, 1)
    const expected = /DurationMs|LatencyMs/.test(key)
      ? 1000
      : /CostUsd|costUsd/.test(key)
        ? grouped
          ? 10
          : 20000
        : grouped
          ? dimensions.length
            ? 1000
            : 1_000_000
          : 2_000_000
    for (const row of panel.data) close(row[measure], expected)
  }
}
const counts = { agents: new Map(), workflows: new Map() }
for (let i = 1; i <= 2_000_000; i++) {
  if (i % 30 === 0) continue // Excluded by the full pages' partial first hour.
  const model = i % 2 === 0 ? "workflows" : "agents"
  const key = JSON.stringify([`Group ${Math.floor(i / 2) % 1000}`, `v${i % 3}`])
  counts[model].set(key, (counts[model].get(key) ?? 0) + 1)
}
let plans = 0
for (const profile of report.profiles) {
  assert.equal(profile.readError, undefined, profile.kind)
  for (const statement of profile.statements) {
    assert.equal(statement.error, undefined, profile.kind)
    assert.ok(statement.plan[0].Plan)
    plans++
  }
  if (profile.kind.endsWith("-page")) {
    const model = profile.kind.replace("-page", "")
    const result = profile.readResult[0]
    assert.equal(result.data.length, 50)
    assert.equal(result.meta.page.total, counts[model].size)
    assert.equal(result.meta.quality.status, "complete")
    for (const row of result.data) {
      const count = counts[model].get(
        JSON.stringify([row[`${model}.name`], row[`${model}.version`]])
      )
      for (const key of [
        "count",
        "completedCount",
        "completeCostCount",
        "durationSampleCount",
      ])
        assert.equal(row[`${model}.${key}`], count)
      for (const key of ["meanDurationMs", "p95DurationMs"])
        assert.equal(row[`${model}.${key}`], 1000)
      for (const key of [
        "erroredCount",
        "runningCount",
        "cancelledCount",
        "errorRate",
      ])
        assert.equal(row[`${model}.${key}`], 0)
      close(row[`${model}.reportedCostUsd`], count * 0.01)
    }
  } else if (profile.kind === "rolling-counts") {
    for (const result of profile.readResult) {
      const model = result.query.measures[0].split(".")[0]
      assert.equal(result.data[0][`${model}.count`], 1_000_000)
      assert.equal(result.data[0][`${model}.meanDurationMs`], 1000)
    }
  }
}
assert.equal(plans, 53)
console.info(
  JSON.stringify({
    event: "correctness",
    passed: true,
    baselineResponses: 24,
    plans,
  })
)
assert.equal(report.clientBusy, 0)
assert.equal(report.acceptedIngestion, 900)
assert.equal(report.committedIngestion, 900)
let reads = 0
for (const [kind, result] of Object.entries(report.summary)) {
  assert.equal(result.completed, result.succeeded, kind)
  if (kind !== "ingest") reads += result.completed
  assert.ok(
    result.p95 < (kind.startsWith("dashboard") ? 2000 : 200),
    `${kind} p95`
  )
}
assert.equal(reads, 900)
for (const profile of report.profiles.filter((item) =>
  item.kind.endsWith("-page")
)) {
  assert.ok(profile.readMs < 2000, profile.kind)
}
console.info(
  JSON.stringify({
    passed: true,
    baselineResponses: 24,
    reads,
    persistedWrites: 900,
    plans,
    qualification: false,
  })
)
