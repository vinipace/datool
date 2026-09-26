import { z } from "zod"

const MILLISECONDS_PER_DAY = 86_400_000

/** The reporting-zone default when a semantic query omits `timezone`. */
export const DEFAULT_SEMANTIC_TIME_ZONE = "UTC" as const

/** Use the runtime ICU database instead of maintaining an incomplete zone list. */
export function isIanaTimeZone(value: string): boolean {
  if (typeof value !== "string" || !value.trim()) return false

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

export const semanticTimeZoneSchema = z
  .string()
  .min(1, "timezone is required.")
  .refine(isIanaTimeZone, "timezone must be an IANA time zone.")

const semanticInstantSchema = z.string().datetime({ offset: true })

/** A complete instant-based half-open interval: `from <= timestamp < to`. */
export const semanticWindowSchema = z
  .object({
    from: semanticInstantSchema,
    to: semanticInstantSchema,
    timezone: semanticTimeZoneSchema.default(DEFAULT_SEMANTIC_TIME_ZONE),
  })
  .strict()
  .superRefine(({ from, to }, context) => {
    if (new Date(to).getTime() <= new Date(from).getTime()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`to` must be after `from` for a half-open window.",
        path: ["to"],
      })
    }
  })

export type SemanticWindow = z.infer<typeof semanticWindowSchema>
export type SemanticWindowInput = z.input<typeof semanticWindowSchema>

export function parseSemanticWindow(
  input: SemanticWindowInput,
  options: { maxDays?: number } = {},
): SemanticWindow {
  const window = semanticWindowSchema.parse(input)
  if (options.maxDays === undefined) return window
  if (!Number.isInteger(options.maxDays) || options.maxDays <= 0) {
    throw new RangeError("maxDays must be a positive integer.")
  }

  if (new Date(window.to).getTime() - new Date(window.from).getTime() > options.maxDays * MILLISECONDS_PER_DAY) {
    throw new RangeError(`Window cannot exceed ${options.maxDays} days.`)
  }
  return window
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>()

function getDayFormatter(timezone: string) {
  semanticTimeZoneSchema.parse(timezone)
  let formatter = dayFormatters.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      calendar: "gregory",
      day: "2-digit",
      month: "2-digit",
      timeZone: timezone,
      year: "numeric",
    })
    dayFormatters.set(timezone, formatter)
  }
  return formatter
}

function toDate(value: Date | string | number) {
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (!Number.isFinite(result.getTime())) {
    throw new RangeError("Semantic day input must be a valid Date or ISO timestamp.")
  }
  return result
}

function formatDay(formatter: Intl.DateTimeFormat, value: Date, timezone: string) {
  const parts = Object.fromEntries(
    formatter
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  )
  if (!parts.year || !parts.month || !parts.day) {
    throw new RangeError(`Unable to format a calendar day for ${timezone}.`)
  }
  return `${parts.year}-${parts.month}-${parts.day}`
}

/** Format an instant as a stable calendar day in the supplied IANA timezone. */
export function formatSemanticDay(value: Date | string | number, timezone: string) {
  return formatDay(getDayFormatter(timezone), toDate(value), timezone)
}

/** Build one formatter for a fact aggregation loop. */
export function createSemanticDayFormatter(timezone: string) {
  const formatter = getDayFormatter(timezone)
  return (value: Date | string | number) => formatDay(formatter, toDate(value), timezone)
}
