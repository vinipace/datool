import { isPercentageMetric } from "@/src/lib/tracer/dashboard-metric-comparison"
import { projectFetch } from "@/lib/workspace-routing"
import type { SemanticMemberAnnotation } from "@/src/lib/semantic/result"
import {
  DashboardRequestError,
  retryDashboardMetricRead,
} from "@/src/lib/tracer/dashboard-read-retry"
export { DashboardRequestError } from "@/src/lib/tracer/dashboard-read-retry"

export async function dashboardRequest<T>(
  path: string,
  method = "GET",
  body?: unknown,
  options?: {
    signal?: AbortSignal
    projectId?: string
    onResponse?: (response: Response) => void
  }
): Promise<T> {
  const load = async (): Promise<T> => {
    const response = await projectFetch(
      path,
      {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: options?.signal,
      },
      options?.projectId
    )
    const result = await response.json()
    if (!response.ok)
      throw new DashboardRequestError(
        result.error?.message ?? "Unable to load dashboard.",
        response.status,
        result.error?.code,
        response.headers.get("Retry-After")
      )
    options?.onResponse?.(response)
    return result.data
  }
  return method === "POST" &&
    ["/api/metrics/query", "/api/metrics/batch"].includes(path)
    ? retryDashboardMetricRead(load, options?.signal)
    : load()
}
export function dashboardCurrencyFormatter(currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function formatDashboardValue(
  value: unknown,
  annotation?: SemanticMemberAnnotation,
  presentation: "full" | "compact" = "full"
) {
  if (value === null || value === undefined)
    return annotation?.kind === "dimension" ? "Not recorded" : "—"
  if (typeof value !== "number") return String(value)
  if (isPercentageMetric(annotation))
    return new Intl.NumberFormat("en-US", {
      style: "percent",
      maximumFractionDigits: 1,
    }).format(value)
  if (annotation?.currency)
    return dashboardCurrencyFormatter(annotation.currency).format(value)
  const compact = presentation === "compact" && annotation?.unit !== "ms"
  const text = new Intl.NumberFormat("en-US", {
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: !compact && annotation?.format === "integer" ? 0 : 2,
  })
    .format(value)
    .toLowerCase()
  return annotation?.unit === "ms" ? `${text} ms` : text
}
