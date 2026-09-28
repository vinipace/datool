/** Canonical names; the historical module remains an API compatibility boundary. */
export {
  customViewInputSchema as pageViewInputSchema,
  customViewUpdateSchema as pageViewUpdateSchema,
  customViewSchema as pageViewSchema,
  evalViewSettingsSchema as pageViewSettingsSchema,
  sameViewSettings as samePageViewSettings,
  type CustomView as PageView,
  type CustomViewInput as PageViewInput,
  type EvalViewSettings as PageViewSettings,
} from "./custom-views"
export { pageViewResources, pageViewResourceSchema, type PageViewResource } from "./view-resources"
