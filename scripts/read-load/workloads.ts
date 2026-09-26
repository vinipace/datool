/** Distinct real queries: batching these cannot collapse to one count query. */
const dateRange = ["2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z"]
const metric = (model: string, measure: string, extra = {}) => ({
  measures: [`${model}.${measure}`],
  timeDimensions: [{ dimension: `${model}.startedAt`, dateRange }],
  limit: 50,
  ...extra,
})
const filtered = (model: string) => ({
  filters: [
    { member: `${model}.name`, operator: "equals", values: ["Group 42"] },
  ],
})
export const dashboardQueries = [
  metric("traces", "count"),
  metric("traces", "meanDurationMs"),
  metric("traces", "p95DurationMs"),
  metric("traces", "reportedCostUsd"),
  metric("logs", "spanCount"),
  metric("logs", "costUsd"),
  metric("logs", "p95LatencyMs"),
  metric("logs", "llmCount"),
  ...["agents", "workflows"].flatMap((model) => [
    metric(model, "count"),
    metric(model, "count", { dimensions: [`${model}.name`] }),
    metric(model, "count", { dimensions: [`${model}.version`] }),
    metric(model, "meanDurationMs", filtered(model)),
    metric(model, "p95DurationMs", filtered(model)),
    metric(model, "reportedCostUsd", filtered(model)),
  ]),
]
const collection = (filter = "", includeTotal = false) =>
  `/api/traces?${new URLSearchParams({ limit: "50", filter, includeTotal: String(includeTotal) })}`
export const readWorkloads = [
  { kind: "collection", path: collection() },
  {
    kind: "workflow-filter",
    path: collection('groupType = "workflow" groupName = "Group 42"'),
  },
  {
    kind: "agent-version-filter",
    path: collection(
      'groupType = "agent" groupName = "Group 42" groupVersion = "v1"'
    ),
  },
  {
    kind: "metadata-filter",
    path: collection('metadata.customer = "customer-42"'),
  },
  {
    kind: "filtered-total",
    path: collection('groupType = "workflow" groupName = "Group 42"', true),
  },
  { kind: "broad-total", path: collection("", true) },
  {
    kind: "dashboard",
    path: "/api/metrics/batch",
    body: { queries: dashboardQueries.slice(0, 4) },
  },
  {
    kind: "dashboard20",
    path: "/api/metrics/batch",
    body: { queries: dashboardQueries },
  },
]
