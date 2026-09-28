import { z } from "zod"

export const objectTypes = ["trace", "dataset-item", "session", "eval-run", "eval-result", "dataset", "app", "agent", "workflow", "review-session", "review-item", "prompt", "scorer", "human-score", "score-collection", "dashboard", "alert", "notification", "table-row"] as const
export const objectTypeSchema = z.enum(objectTypes)
export type ViewObjectType = z.infer<typeof objectTypeSchema>

/** Every product table declares its row contract here, including legacy resource names. */
export const pageViewResources = {
  traces: { label: "Traces", objectType: "trace", path: "traces" },
  sessions: { label: "Sessions", objectType: "session", path: "sessions" },
  "session-traces": { label: "Session traces", objectType: "trace", path: "sessions" },
  "eval-runs": { label: "Evaluation results", objectType: "eval-result", path: "evals" },
  evaluations: { label: "Evaluations", objectType: "eval-run", path: "evals" },
  "eval-results": { label: "Evaluation query", objectType: "eval-result", path: "evals" },
  "eval-comparison": { label: "Evaluation comparison", objectType: "eval-result", path: "evals/compare" },
  datasets: { label: "Datasets", objectType: "dataset", path: "datasets" },
  "dataset-items": { label: "Dataset items", objectType: "dataset-item", path: "datasets" },
  "dataset-item-runs": { label: "Dataset item runs", objectType: "trace", path: "datasets" },
  "playground-apps": { label: "Playground apps", objectType: "app", path: "playground" },
  "playground-traces": { label: "Playground traces", objectType: "trace", path: "playground" },
  agents: { label: "Agents", objectType: "agent", path: "agents" },
  workflows: { label: "Workflows", objectType: "workflow", path: "workflows" },
  reviews: { label: "Reviews", objectType: "review-session", path: "reviews" },
  "review-session": { label: "Review items", objectType: "review-item", path: "reviews" },
  prompts: { label: "Prompts", objectType: "prompt", path: "prompts" },
  scorers: { label: "Scorers", objectType: "scorer", path: "scorers" },
  "human-scores": { label: "Human Scores", objectType: "human-score", path: "human-scores" },
  "score-collections": { label: "Score collections", objectType: "score-collection", path: "human-scores" },
  dashboards: { label: "Dashboards", objectType: "dashboard", path: "dashboards" },
  reports: { label: "Reports", objectType: "table-row", path: "reports" },
  "dashboard-table": { label: "Dashboard table", objectType: "table-row", path: "dashboards" },
  alerts: { label: "Alerts", objectType: "alert", path: "alerts" },
  notifications: { label: "Notifications", objectType: "notification", path: "alerts" },
} as const satisfies Record<string, { label: string; objectType: ViewObjectType; path: string }>
export const pageViewResourceSchema = z.enum(Object.keys(pageViewResources) as [keyof typeof pageViewResources, ...(keyof typeof pageViewResources)[]])
export type PageViewResource = keyof typeof pageViewResources
export const viewResourceKindSchema = z.enum(["page-view", "custom-field", "object-view"])
export type ViewResourceKind = z.infer<typeof viewResourceKindSchema>
export const fieldReferenceSchema = z.object({ id: z.string().min(1).max(200), revision: z.number().int().positive().optional() }).strict()
export const viewPreferenceSchema = z.object({
  scope: z.string().min(1).max(500),
  expectedRevision: z.number().int().nonnegative(),
  value: z.record(z.string(), z.json()),
}).strict()

const transientParams = new Set(["view", "pageView", "pageViewRevision", "trace", "span", "item", "itemTab", "objectView", "annotation", "cursor", "offset"])
/** Preserve the page's actual query grammar, including relative date expressions. */
export function pageViewQueryParams(params: URLSearchParams) {
  const result: Record<string, string[]> = {}
  for (const [key, value] of params) {
    if (!transientParams.has(key)) (result[key] ??= []).push(value)
  }
  return result
}
export function applyPageViewQueryParams(current: URLSearchParams, saved: Record<string, string[]>) {
  const next = new URLSearchParams(current)
  for (const key of [...next.keys()]) if (!transientParams.has(key)) next.delete(key)
  for (const [key, values] of Object.entries(saved)) {
    if (transientParams.has(key)) continue
    values.forEach(value => next.append(key, value))
  }
  return next
}

/** Item inspectors share the underlying dataset table's saved selection and drafts. */
export function pageViewPathname(path: string) {
  return path.replace(/^(\/p\/[^/]+\/datasets\/[^/]+)\/[^/]+\/?$/, "$1")
}

export function pageResourceForPath(path: string, context = ""): PageViewResource | undefined {
  const page = path.replace(/^\/p\/[^/]+/, "").split("/").filter(Boolean)
  if (page[0] === "traces") return "traces"
  if (page[0] === "sessions") return page[1] || context.includes("trace") ? "session-traces" : "sessions"
  if (page[0] === "datasets") return context.includes("run") ? "dataset-item-runs" : page[1] ? "dataset-items" : "datasets"
  if (page[0] === "evals") return page[1] === "compare" ? "eval-comparison" : page[1] ? "eval-runs" : "evaluations"
  if (page[0] === "playground") return page[1] ? "playground-traces" : "playground-apps"
  if (page[0] === "reviews") return page[1] ? "review-session" : "reviews"
  if (page[0] === "dashboards") return page[1] ? "dashboard-table" : "dashboards"
  return pageViewResourceSchema.safeParse(page[0]).success ? page[0] as PageViewResource : undefined
}
