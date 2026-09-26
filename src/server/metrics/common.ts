import { SemanticModelQueryError } from "@/src/lib/semantic/model"
import type {
  NormalizedSemanticQuery,
  SemanticFilterOperator,
} from "@/src/lib/semantic/query"
import type { SemanticQuality } from "@/src/lib/semantic/result"
import {
  createSemanticDayFormatter,
  parseSemanticWindow,
  type SemanticWindow,
} from "@/src/lib/semantic/runtime/time"
export const METRIC_MODEL_VERSION = "v1" as const
export const METRIC_MAX_WINDOW_DAYS = 90 as const
export const METRIC_MAX_LIMIT = 5_000 as const

export const idFilterOperators = [
  "equals",
  "notEquals",
  "in",
  "notIn",
  "set",
  "notSet",
] as const satisfies readonly SemanticFilterOperator[]

export const labelFilterOperators = [
  ...idFilterOperators,
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
] as const satisfies readonly SemanticFilterOperator[]

export type MetricWindow = Readonly<{
  formatDay: (value: Date | string | number) => string
  from: string
  fromMs: number
  hasDayGrain: boolean
  to: string
  toMs: number
}>

export function metricWindow(
  query: NormalizedSemanticQuery,
  member: string
): MetricWindow {
  if (query.timeDimensions.length !== 1) {
    throw new SemanticModelQueryError(
      "MODEL_QUERY_INVALID",
      `Queries for '${member.slice(0, member.indexOf("."))}' require exactly one '${member}' time dimension with a bounded dateRange.`,
      ["timeDimensions"]
    )
  }

  const timeDimension = query.timeDimensions[0]!
  if (timeDimension.dimension !== member) {
    throw new SemanticModelQueryError(
      "MODEL_QUERY_INVALID",
      `Only '${member}' is available as this model's time dimension.`,
      ["timeDimensions", 0, "dimension"]
    )
  }

  let window: SemanticWindow
  try {
    window = parseSemanticWindow(
      {
        from: timeDimension.dateRange[0],
        to: timeDimension.dateRange[1],
        timezone: query.timezone,
      },
      { maxDays: METRIC_MAX_WINDOW_DAYS }
    )
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid time window."
    throw new SemanticModelQueryError("MODEL_QUERY_INVALID", message, [
      "timeDimensions",
      0,
    ])
  }

  const day = createSemanticDayFormatter(query.timezone)
  return {
    formatDay: (value) => {
      const date = day(value)
      if (timeDimension.granularity === "month") return `${date.slice(0, 7)}-01`
      if (timeDimension.granularity === "week") {
        const monday = new Date(`${date}T00:00:00Z`)
        monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7))
        return monday.toISOString().slice(0, 10)
      }
      return date
    },
    from: window.from,
    fromMs: Date.parse(window.from),
    hasDayGrain: timeDimension.granularity !== undefined,
    to: window.to,
    toMs: Date.parse(window.to),
  }
}

export function quality(
  limitations: readonly string[],
  warnings: readonly string[]
): SemanticQuality {
  return {
    limitations: [...limitations],
    status: warnings.length ? "partial" : "complete",
    warnings: [...warnings],
  }
}
