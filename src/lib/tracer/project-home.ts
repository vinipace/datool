import { z } from "zod"
import { dashboardLayoutSchema, type DashboardContentWidget } from "./dashboards"

export const HOME_WIDGET_LIMIT = 20
const id = z.string().min(1).max(200)
export const pinHomeWidgetSchema = z
  .object({ dashboardId: id, widgetId: id })
  .strict()
export const homePinSchema = pinHomeWidgetSchema.extend({
  id,
  title: z.string().max(160),
  dashboardName: z.string().max(160),
  layout: dashboardLayoutSchema,
})
export const homePinsSchema = z.array(homePinSchema).max(HOME_WIDGET_LIMIT)
export const homeLayoutSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    layout: z
      .array(z.object({ id, layout: dashboardLayoutSchema }).strict())
      .max(HOME_WIDGET_LIMIT),
  })
  .strict()
export type HomePin = z.infer<typeof homePinSchema>
export type ProjectHome = {
  revision: number
  pins: (HomePin & { unavailable?: string })[]
  widgets: DashboardContentWidget[]
}
