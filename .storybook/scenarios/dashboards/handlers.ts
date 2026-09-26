import { delay, http, HttpResponse } from "msw"
import {
  dashboardInputSchema,
  type Dashboard,
} from "@/src/lib/tracer/dashboards"
import {
  dashboardCatalog,
  dashboardList,
  isNoMatchQuery,
  performanceResult,
  semanticResultForQuery,
  storybookDashboard,
} from "./fixtures"

export type RemoteScenario = "populated" | "empty" | "loading" | "error"

type HandlerOptions = { once?: boolean }

function optionsFor({ once }: HandlerOptions) {
  return once ? { once: true } : undefined
}

export function envelope<T>(data: T) {
  return HttpResponse.json({ data })
}

export function apiError(message: string, status = 500) {
  return HttpResponse.json({ error: { message } }, { status })
}

export function dashboardListHandler(
  scenario: RemoteScenario = "populated",
  options: HandlerOptions = {}
) {
  return http.get(
    "/api/dashboards",
    async () => {
      if (scenario === "loading") {
        await delay("infinite")
        return envelope(dashboardList)
      }
      if (scenario === "error") return apiError("Dashboards are unavailable.")
      return envelope(scenario === "empty" ? [] : dashboardList)
    },
    optionsFor(options)
  )
}

export function dashboardDetailHandler(
  scenario: RemoteScenario = "populated",
  options: HandlerOptions & { dashboard?: Dashboard } = {}
) {
  return http.get(
    "/api/dashboards/:dashboardId",
    async () => {
      if (scenario === "loading") {
        await delay("infinite")
        return envelope(options.dashboard ?? storybookDashboard)
      }
      if (scenario === "error")
        return apiError("Dashboard could not be loaded.")
      return envelope(options.dashboard ?? storybookDashboard)
    },
    optionsFor(options)
  )
}

export function dashboardCatalogHandler(
  scenario: RemoteScenario = "populated",
  options: HandlerOptions = {}
) {
  return http.get(
    "/api/metrics/meta",
    async () => {
      if (scenario === "loading") {
        await delay("infinite")
        return envelope(dashboardCatalog)
      }
      if (scenario === "error")
        return apiError("Metric catalog is unavailable.")
      return envelope(dashboardCatalog)
    },
    optionsFor(options)
  )
}

export function metricsBatchHandler(
  scenario: RemoteScenario = "populated",
  options: HandlerOptions = {}
) {
  return http.post(
    "/api/metrics/batch",
    async ({ request }) => {
      if (scenario === "loading") {
        await delay("infinite")
        return envelope([])
      }
      if (scenario === "error") return apiError("Metric batch is unavailable.")
      const body = (await request.json()) as { queries?: unknown[] }
      return envelope(
        (body.queries ?? []).map((query) =>
          semanticResultForQuery(query, { empty: scenario === "empty" })
        )
      )
    },
    optionsFor(options)
  )
}

export function metricsQueryHandler(
  scenario: RemoteScenario = "populated",
  options: HandlerOptions = {}
) {
  return http.post(
    "/api/metrics/query",
    async ({ request }) => {
      if (scenario === "loading") {
        await delay("infinite")
        return envelope(performanceResult("agents"))
      }
      if (scenario === "error")
        return apiError("Performance metrics are unavailable.")
      const query = await request.json()
      return envelope(
        scenario === "empty" || isNoMatchQuery(query)
          ? semanticResultForQuery(query, { empty: true })
          : semanticResultForQuery(query)
      )
    },
    optionsFor(options)
  )
}

export function customFieldsHandler(options: HandlerOptions = {}) {
  return http.get("/api/custom-fields", () => envelope([]), optionsFor(options))
}

export function customViewsHandler(options: HandlerOptions = {}) {
  return http.get("/api/custom-views", () => envelope([]), optionsFor(options))
}

export function dashboardMutationHandlers(
  options: {
    initial?: Dashboard
    saveError?: string
    conflict?: boolean
    delayMs?: number
    onSave?: (dashboard: Dashboard) => void
  } = {}
) {
  let saved = structuredClone(options.initial ?? storybookDashboard)
  return [
    http.get("/api/dashboards/:dashboardId", () => envelope(saved)),
    http.post("/api/dashboards", async ({ request }) => {
      const config = dashboardInputSchema.parse(await request.json())
      saved = { ...saved, ...config, id: "dash_storybook_created", revision: 1 }
      return envelope(saved)
    }),
    http.patch("/api/dashboards/:dashboardId", async ({ request }) => {
      const { config, expectedRevision } = (await request.json()) as {
        config: unknown
        expectedRevision: number
      }
      if (options.delayMs) await delay(options.delayMs)
      if (options.saveError) return apiError(options.saveError)
      if (options.conflict || expectedRevision !== saved.revision)
        return apiError(
          "This dashboard changed. Reopen it before saving again.",
          409
        )
      saved = {
        ...saved,
        ...dashboardInputSchema.parse(config),
        revision: saved.revision + 1,
        updatedAt: new Date().toISOString(),
      }
      options.onSave?.(saved)
      return envelope(saved)
    }),
    http.delete("/api/dashboards/:dashboardId", () =>
      envelope({ id: saved.id })
    ),
  ]
}

export function dashboardPageHandlers(scenario: RemoteScenario = "populated") {
  return [
    dashboardListHandler(scenario),
    dashboardCatalogHandler(),
    metricsBatchHandler(),
    ...dashboardMutationHandlers(),
  ]
}

export function dashboardDetailHandlers(
  scenario: RemoteScenario = "populated"
) {
  return [
    ...(scenario === "populated" ? [] : [dashboardDetailHandler(scenario)]),
    dashboardCatalogHandler(),
    metricsBatchHandler(),
    ...dashboardMutationHandlers(),
  ]
}

export function performanceHandlers(scenario: RemoteScenario = "populated") {
  return [
    metricsQueryHandler(scenario),
    customFieldsHandler(),
    customViewsHandler(),
  ]
}
