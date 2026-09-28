import { dashboardPresentationSchema } from "./dashboard-presentation"
import { z } from "zod"
import {
  semanticQuerySchema,
  type NormalizedSemanticQuery,
} from "@/src/lib/semantic/query"
import type { SemanticCatalogModelMetadata } from "@/src/lib/semantic/catalog"
import { invocationSelectionSchema } from "@/src/lib/semantic/group-filter"

export const dashboardLayoutSchema = z
  .object({
    x: z.number().int().min(0).max(11),
    y: z.number().int().min(0).max(10000),
    w: z.number().int().min(1).max(12),
    h: z.number().int().min(2).max(100),
  })
  .strict()
  .refine((layout) => layout.x + layout.w <= 12, {
    message: "Widget layout must fit within the 12-column canvas.",
  })

export const dashboardDataWidgetSchema = z
  .object({
    id: z.string().min(1).max(100),
    title: z.string().trim().min(1).max(160),
    type: z.enum([
      "metric",
      "bar",
      "donut",
      "table",
      "stacked",
      "line",
      "matrix",
      "scatter",
    ]),
    width: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    /** Older dashboards use width; canvas edits persist exact grid coordinates. */
    layout: dashboardLayoutSchema.optional(),
    /** Group icons are opt-in; omitted settings preserve existing charts. */
    showGroupIcons: z.boolean().optional(),
    trendDirection: z.enum(["increase", "decrease", "neutral"]).optional(),
    presentation: dashboardPresentationSchema.optional(),
    query: semanticQuerySchema,
    series: z.array(z.string()).min(1).optional(),
    groups: z.array(invocationSelectionSchema).max(20).optional(),
    compare: invocationSelectionSchema
      .pick({ type: true, name: true })
      .optional(),
  })
  .strict()
  .superRefine((widget, ctx) => {
    if (
      widget.type === "matrix" &&
      widget.presentation?.showSummary &&
      widget.query.having?.length
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Matrix row summaries cannot be combined with aggregate thresholds.",
      })
    if (
      widget.type === "matrix" &&
      (widget.query.measures.length !== 1 ||
        widget.query.dimensions.length < 2 ||
        widget.query.timeDimensions.some((time) => time.granularity))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Matrices require one measure and at least two dimension fields. The final field supplies columns; preceding fields supply rows.",
      })
    if (
      widget.type === "scatter" &&
      (widget.query.measures.length !== 2 ||
        widget.query.dimensions.length < 1 ||
        widget.query.timeDimensions.some((t) => t.granularity))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Scatter plots require two measures (X, Y), at least one dimension, and no time grouping.",
      })
    const selections = widget.groups ?? []
    if (
      new Set(
        selections.map((group) => JSON.stringify([group.type, group.name]))
      ).size !== selections.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Agent and workflow selections must be unique.",
      })
    if (
      selections.some(
        (group) =>
          group.versions &&
          new Set(group.versions).size !== group.versions.length
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Selected versions must be unique.",
      })
    if (
      selections.length &&
      !["logs", "traces", "agents", "workflows"].includes(
        widget.query.measures[0].split(".")[0]
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Agent and workflow filters are unavailable for this model.",
      })
    if (
      widget.compare &&
      !selections.some(
        (group) =>
          group.type === widget.compare?.type &&
          group.name === widget.compare.name &&
          (group.versions?.length ?? 0) >= 2
      )
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Select at least two versions of the compared agent or workflow.",
      })
    const groups = [
      ...widget.query.dimensions,
      ...widget.query.timeDimensions
        .filter((t) => t.granularity)
        .map((t) => t.dimension),
    ]
    if (
      widget.series?.some((member) => !widget.query.measures.includes(member))
    )
      ctx.addIssue({
        code: "custom",
        message: "Chart series must be selected measures.",
      })
    if (
      ["stacked", "line"].includes(widget.type) &&
      (widget.query.dimensions.length > 1 ||
        widget.query.timeDimensions.filter((t) => t.granularity).length !== 1)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Time charts require one time grouping and at most one series dimension.",
      })
    if (widget.query.timeDimensions.length !== 1)
      ctx.addIssue({
        code: "custom",
        message: "Choose exactly one bounded time dimension.",
        path: ["query", "timeDimensions"],
      })
    if (
      widget.type === "metric" &&
      (widget.query.measures.length !== 1 ||
        groups.length ||
        widget.query.offset !== 0)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Metric tiles require one measure, no grouping, and offset zero.",
      })
    if (
      (widget.type === "bar" || widget.type === "donut") &&
      (widget.query.measures.length !== 1 || groups.length < 1)
    )
      ctx.addIssue({
        code: "custom",
        message: `${widget.type === "donut" ? "Donut" : "Bar"} charts require one measure and at least one grouping.`,
      })
  })
export const dashboardTextWidgetSchema = z
  .object({
    id: z.string().min(1).max(100),
    title: z.string().trim().min(1).max(160),
    type: z.literal("text"),
    width: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    layout: dashboardLayoutSchema.optional(),
    content: z.string().max(20000),
  })
  .strict()
export const dashboardWidgetSchema = dashboardDataWidgetSchema
export const dashboardContentWidgetSchema = z.union([
  dashboardDataWidgetSchema,
  dashboardTextWidgetSchema,
])
/** Existing chart utilities operate on data widgets; canvas content also includes text. */
export type DashboardWidget = z.infer<typeof dashboardDataWidgetSchema>
export type DashboardTextWidget = z.infer<typeof dashboardTextWidgetSchema>
export type DashboardContentWidget = z.infer<
  typeof dashboardContentWidgetSchema
>
export function isDashboardDataWidget(
  widget: DashboardContentWidget
): widget is DashboardWidget {
  return widget.type !== "text"
}
export function newDashboardTextWidget(): DashboardTextWidget {
  return {
    id: crypto.randomUUID(),
    title: "Text",
    type: "text",
    width: 3,
    content: "",
  }
}
export const dashboardInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(1000),
    widgets: z.array(dashboardContentWidgetSchema).max(20),
    defaultWindowDays: z.number().int().min(1).max(90).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.widgets.map((w) => w.id)).size !== value.widgets.length)
      ctx.addIssue({
        code: "custom",
        message: "Widget IDs must be unique.",
        path: ["widgets"],
      })
  })
export type DashboardInput = z.infer<typeof dashboardInputSchema>
export type DashboardDataInput = Omit<DashboardInput, "widgets"> & {
  widgets: DashboardWidget[]
}

/** Expand the former category shortcut when editing; saved queries stay readable. */
export function expandLegacyDashboardGrouping(
  widget: DashboardWidget
): DashboardWidget {
  if (!widget.query.dimensions.includes("evalQuality.groupModel")) return widget
  const expand = (name: string) =>
    name === "evalQuality.groupModel"
      ? ["evalQuality.groupName", "evalQuality.model"]
      : [name]
  const order = widget.query.order.flatMap(([name, direction]) =>
    expand(name).map(
      (field) => [field, direction] as [string, typeof direction]
    )
  )
  return {
    ...widget,
    query: {
      ...widget.query,
      dimensions: [...new Set(widget.query.dimensions.flatMap(expand))],
      order: order.filter(
        ([name], index) =>
          order.findIndex(([field]) => field === name) === index
      ),
    },
  }
}
export type Dashboard = DashboardInput & {
  id: string
  revision: number
  createdAt: string
  updatedAt: string
}
export const dashboardUpdateSchema = z
  .object({
    config: dashboardInputSchema,
    expectedRevision: z.number().int().positive(),
  })
  .strict()

export function newDashboardWidget(
  model: SemanticCatalogModelMetadata,
  now = new Date()
): DashboardWidget {
  const measure =
    model.members.find((m) => m.name === model.defaultMeasures?.[0]) ??
    model.members.find((m) => m.kind === "measure")!
  const time = model.members.find((m) => m.kind === "timeDimension")!
  return {
    id: crypto.randomUUID(),
    title: measure.title,
    type: "metric",
    width: 1,
    query: semanticQuerySchema.parse({
      measures: [measure.name],
      timeDimensions: [
        {
          dimension: time.name,
          dateRange: [
            new Date(now.getTime() - 7 * 86400000).toISOString(),
            now.toISOString(),
          ],
        },
      ],
      limit: Math.min(100, model.maxLimit ?? 100),
      total: true,
    }),
  }
}
/** Shared defaults for the dashboard and report composers. */
export function newDashboardContentWidget(
  type: DashboardContentWidget["type"],
  model: SemanticCatalogModelMetadata,
  now = new Date()
): DashboardContentWidget {
  if (type === "text") return newDashboardTextWidget()
  const widget = newDashboardWidget(model, now)
  widget.type = type
  const dimensions = model.members.filter(
    (member) => member.kind === "dimension" && member.groupable !== false
  )
  if (type === "scatter") {
    widget.width = 2
    widget.query.measures = model.members
      .filter((m) => m.kind === "measure")
      .slice(0, 2)
      .map((m) => m.name)
    widget.query.dimensions = dimensions.slice(0, 1).map((m) => m.name)
  }
  if (type === "matrix") {
    widget.width = 3
    widget.query.dimensions = dimensions
      .slice(0, 2)
      .map((member) => member.name)
    if (
      model.name === "evalResults" &&
      model.members.some((member) => member.name === "evalResults.meanScore")
    ) {
      widget.title = "Prompt version × dataset"
      widget.query.measures = ["evalResults.meanScore"]
      // Keep scorer versions and operation provenance separate when comparing.
      widget.query.dimensions = [
        "groupName",
        "promptId",
        "evaluatorName",
        "evaluatorVersion",
        "promptVersion",
        "datasetId",
      ].map((key) => `evalResults.${key}`)
      widget.query.order = widget.query.dimensions.map((name) => [name, "asc"])
    }
  }
  if (type === "line" || type === "stacked")
    widget.query.timeDimensions[0].granularity = "day"
  if (type === "bar" || type === "donut") {
    if (dimensions[0]) widget.query.dimensions = [dimensions[0].name]
    else widget.query.timeDimensions[0].granularity = "day"
  }
  return dashboardContentWidgetSchema.parse(widget)
}
export function dashboardColumns(query: NormalizedSemanticQuery) {
  return [
    ...query.dimensions,
    ...query.timeDimensions
      .filter((t) => t.granularity)
      .map((t) => t.dimension),
    ...query.measures,
  ]
}
