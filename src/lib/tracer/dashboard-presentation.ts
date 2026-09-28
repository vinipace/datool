import { z } from "zod"
import type {
  SemanticResult,
  SemanticMemberAnnotation,
} from "@/src/lib/semantic/result"

const label = z.string().trim().min(1).max(120)
export const memberDisplaySchema = z
  .object({
    unit: z
      .enum(["auto", "seconds", "milliseconds", "USD", "percent", "number"])
      .optional(),
    decimals: z.number().int().min(0).max(6).optional(),
    values: z.record(z.string(), label).optional(),
  })
  .strict()
export const dashboardPresentationSchema = z
  .object({
    showSummary: z.boolean().optional(),
    labels: z.record(z.string().min(1), label).optional(),
    members: z.record(z.string().min(1), memberDisplaySchema).optional(),
  })
  .strict()
export type DashboardPresentation = z.infer<typeof dashboardPresentationSchema>
export type DisplayAnnotation = SemanticMemberAnnotation & {
  display?: z.infer<typeof memberDisplaySchema>
}

export function validateDashboardPresentation(
  presentation: DashboardPresentation | undefined,
  query: SemanticResult["query"],
  lookup: (
    key: string
  ) => Pick<SemanticMemberAnnotation, "kind" | "unit"> | undefined
) {
  if (!presentation) return
  const selected = new Set([
    ...query.measures,
    ...query.dimensions,
    ...query.timeDimensions.map((t) => t.dimension),
  ])
  for (const key of [
    ...Object.keys(presentation.labels ?? {}),
    ...Object.keys(presentation.members ?? {}),
  ])
    if (!selected.has(key))
      throw new Error("Presentation addresses an unselected member: " + key)
  for (const [key, display] of Object.entries(presentation.members ?? {})) {
    const member = lookup(key)
    if (!member) throw new Error("Unknown presentation member: " + key)
    if (display?.values && member.kind !== "dimension")
      throw new Error("Value aliases require a dimension.")
    const unit = display?.unit
    if (
      unit &&
      unit !== "auto" &&
      !(
        unit === "number" ||
        (unit === "USD" && member.unit === "USD") ||
        (unit === "percent" && member.unit === "ratio") ||
        (["seconds", "milliseconds"].includes(unit) && member.unit === "ms")
      )
    )
      throw new Error("Presentation unit is incompatible with " + key)
    if (member.kind !== "measure" && (unit || display?.decimals !== undefined))
      throw new Error("Numeric presentation requires a measure.")
  }
}

export function presentDashboardResult(
  result: SemanticResult,
  presentation?: DashboardPresentation
): SemanticResult {
  if (!presentation) return result
  validateDashboardPresentation(
    presentation,
    result.query,
    (key) =>
      result.annotation.measures[key] ??
      result.annotation.dimensions[key] ??
      result.annotation.timeDimensions[key]
  )
  const annotation = Object.fromEntries(
    Object.entries(result.annotation).map(([kind, members]) => [
      kind,
      Object.fromEntries(
        Object.entries(members).map(([key, member]) => {
          const display = presentation.members?.[key]
          return [
            key,
            {
              ...member,
              ...(presentation.labels?.[key]
                ? { title: presentation.labels[key] }
                : {}),
              ...(display ? { display } : {}),
            },
          ]
        })
      ),
    ])
  ) as SemanticResult["annotation"]
  return { ...result, annotation }
}

export function formatDisplayValue(
  value: unknown,
  annotation?: DisplayAnnotation
): string | undefined {
  const display = annotation?.display
  if (!display) return undefined
  if (
    display.values &&
    value != null &&
    Object.hasOwn(display.values, String(value))
  )
    return display.values[String(value)]
  if (typeof value !== "number") return undefined
  const unit = display.unit ?? "auto"
  const percent =
    unit === "percent" || (unit === "auto" && annotation?.format === "percent")
  const currency = unit === "USD" || (unit === "auto" && annotation?.currency)
  const digits = display.decimals ?? (currency ? 2 : 1)
  const formatted = new Intl.NumberFormat("en-US", {
    style: percent ? "percent" : currency ? "currency" : "decimal",
    ...(currency ? { currency: annotation?.currency ?? "USD" } : {}),
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(unit === "seconds" ? value / 1000 : value)
  return (
    formatted +
    (unit === "seconds"
      ? " s"
      : unit === "milliseconds" ||
          (unit === "auto" && annotation?.unit === "ms")
        ? " ms"
        : "")
  )
}
