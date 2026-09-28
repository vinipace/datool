import { z } from "zod"
import type { DashboardInput } from "./dashboards"
import type { ReportSnapshot } from "./reports"

const selector = z
  .object({
    widgetId: z.string().min(1).max(100),
    measure: z.string().min(1).max(200),
    dimensions: z.record(
      z.string().min(1),
      z.union([z.string(), z.number().finite(), z.boolean(), z.null()])
    ),
  })
  .strict()
export const reportBindingSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
    textWidgetId: z.string().min(1).max(100),
    source: selector,
    operation: z.enum([
      "value",
      "difference",
      "relativeChange",
      "ratio",
      "percentagePoints",
    ]),
    baseline: selector.optional(),
    format: z.enum(["number", "percent", "USD"]).optional(),
    decimals: z.number().int().min(0).max(6).optional(),
    expected: z.number().finite().optional(),
    tolerance: z.number().finite().min(0).max(1).optional(),
  })
  .strict()
  .refine(
    (v) => (v.operation === "value") === !v.baseline,
    "A baseline is required only for calculations."
  )
export type ReportBinding = z.infer<typeof reportBindingSchema>
export type ResolvedReportEvidence = {
  binding: ReportBinding
  sourceValue: number
  baselineValue?: number
  value: number
  formatted: string
}

/** Resolve exclusively against this report's captured rows. Never execute arbitrary expressions. */
export function resolveReportEvidence(
  config: DashboardInput,
  snapshot: ReportSnapshot,
  bindings: ReportBinding[] = []
) {
  const read = (selection: ReportBinding["source"]) => {
    const widget = config.widgets.find((w) => w.id === selection.widgetId)
    const position = snapshot.positions.find((p) => p.id === selection.widgetId)
    if (
      !widget ||
      widget.type === "text" ||
      widget.groups?.length ||
      !position ||
      position.cohorts.length !== 1
    )
      throw new Error(
        "Evidence needs one data widget without comparison cohorts."
      )
    const result = snapshot.results[position.cohorts[0].result]
    if (
      !result.query.measures.includes(selection.measure) ||
      Object.keys(selection.dimensions).some(
        (key) =>
          ![
            ...result.query.dimensions,
            ...result.query.timeDimensions
              .filter((t) => t.granularity)
              .map((t) => t.dimension),
          ].includes(key)
      )
    )
      throw new Error(
        "Evidence selectors must address selected measures and dimensions."
      )
    const matches = result.data.filter((row) =>
      Object.entries(selection.dimensions).every(
        ([key, value]) => row[key] === value
      )
    )
    const value = matches[0]?.[selection.measure]
    if (
      matches.length !== 1 ||
      typeof value !== "number" ||
      !Number.isFinite(value)
    )
      throw new Error(
        "Evidence must resolve to exactly one finite numeric cell."
      )
    return { value, unit: result.annotation.measures[selection.measure]?.unit }
  }
  if (new Set(bindings.map((b) => b.id)).size !== bindings.length)
    throw new Error("Evidence binding IDs must be unique.")
  const templates: Record<string, string> = Object.create(null)
  const resolved: ResolvedReportEvidence[] = bindings.map((binding) => {
    const text = config.widgets.find((w) => w.id === binding.textWidgetId)
    if (
      !text ||
      text.type !== "text" ||
      !text.content.includes("{{evidence." + binding.id + "}}")
    )
      throw new Error(
        "Evidence binding must be used in its selected text widget."
      )
    templates[text.id] = text.content
    const source = read(binding.source),
      baseline = binding.baseline ? read(binding.baseline) : undefined
    if (baseline && source.unit !== baseline.unit)
      throw new Error("Evidence calculations require matching source units.")
    if (binding.operation === "percentagePoints" && source.unit !== "ratio")
      throw new Error("Percentage-point changes require ratios.")
    if (
      ["relativeChange", "ratio"].includes(binding.operation) &&
      baseline?.value === 0
    )
      throw new Error("Evidence cannot divide by zero.")
    const value =
      binding.operation === "value"
        ? source.value
        : binding.operation === "difference"
          ? source.value - baseline!.value
          : binding.operation === "percentagePoints"
            ? 100 * (source.value - baseline!.value)
            : binding.operation === "relativeChange"
              ? (source.value - baseline!.value) / Math.abs(baseline!.value)
              : source.value / baseline!.value
    if (!Number.isFinite(value))
      throw new Error("Evidence calculation is not finite.")
    if (
      binding.expected !== undefined &&
      Math.abs(value - binding.expected) > (binding.tolerance ?? 1e-9)
    )
      throw new Error(
        "Evidence did not match the author's expected value: " + binding.id
      )
    const derivedRatio = ["relativeChange", "ratio"].includes(binding.operation)
    if (
      binding.format === "USD" &&
      (source.unit !== "USD" ||
        derivedRatio ||
        binding.operation === "percentagePoints")
    )
      throw new Error(
        "Currency evidence requires a currency value or difference."
      )
    if (
      binding.format === "percent" &&
      !derivedRatio &&
      (source.unit !== "ratio" || binding.operation === "percentagePoints")
    )
      throw new Error("Percent formatting requires a ratio.")
    const digits = binding.decimals ?? 1
    const formatted = new Intl.NumberFormat("en-US", {
      style:
        binding.format === "USD"
          ? "currency"
          : binding.format === "percent"
            ? "percent"
            : "decimal",
      ...(binding.format === "USD" ? { currency: "USD" } : {}),
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value)
    return {
      binding,
      sourceValue: source.value,
      ...(baseline ? { baselineValue: baseline.value } : {}),
      value,
      formatted,
    }
  })
  const widgets = config.widgets.map((widget) => {
    if (widget.type !== "text") return widget
    const content = widget.content.replace(
      /\{\{evidence\.([^}]+)\}\}/g,
      (_, id: string) => {
        const item = resolved.find(
          (r) => r.binding.id === id && r.binding.textWidgetId === widget.id
        )
        if (!item) throw new Error("Unresolved evidence token: " + id)
        return item.formatted
      }
    )
    return { ...widget, content }
  })
  return {
    config: { ...config, widgets },
    evidence: { templates, values: resolved },
  }
}
