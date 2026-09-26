import { expect, test } from "bun:test"
import { performanceTableRow } from "@/src/lib/tracer/performance-table"

test("performance rows keep group identity and nullable aggregate metrics distinct", () => {
  const source = {
    "agents.name": "extract",
    "agents.version": null,
    "agents.count": 10,
    "agents.versionCount": 3,
    "agents.erroredCount": 0,
    "agents.reportedCostUsd": null,
    "agents.meanDurationMs": 45.5,
  }
  const row = performanceTableRow(source, "agents")
  expect(row).toMatchObject({
    groupType: "agent",
    name: "extract",
    version: null,
    metrics: {
      count: 10,
      versionCount: 3,
      erroredCount: 0,
      reportedCostUsd: null,
      meanDurationMs: 45.5,
      p95DurationMs: null,
    },
  })
  expect(performanceTableRow({ ...source }, "agents").id).toBe(row.id)
  expect(
    performanceTableRow({ ...source, "agents.version": "null" }, "agents").id
  ).not.toBe(row.id)
  expect(
    performanceTableRow({ ...source, "agents.version": "v1" }, "agents").id
  ).not.toBe(row.id)
  const workflow = performanceTableRow(
    { "workflows.name": "extract", "workflows.count": 4 },
    "workflows"
  )
  expect(workflow).toMatchObject({
    groupType: "workflow",
    version: null,
    metrics: { count: 4 },
  })
  expect(workflow.id).not.toBe(row.id)
  expect(source["agents.reportedCostUsd"]).toBeNull()
})
