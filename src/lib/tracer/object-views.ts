import { z } from "zod"
import { createReactViewSchema, reactViewInputSchema, updateReactViewSchema } from "./react-views"
import type { DatasetItem, TraceDetail } from "./contracts"
import type { TraceViewData } from "./trace-view-contract"

export const objectViewInputSchema = reactViewInputSchema.extend({ inputContract: z.enum(["legacy-trace", "object"]).default("object") })
export const createObjectViewSchema = createReactViewSchema.extend({ inputContract: objectViewInputSchema.shape.inputContract })
export const updateObjectViewSchema = updateReactViewSchema
export type ObjectViewContext = {
  unsaved: boolean
  fieldRevisions?: Record<string, number | undefined>
  fieldErrors?: Record<string, string>
}
export type ObjectViewInput =
  | { kind: "trace"; object: TraceViewData; context: ObjectViewContext & { unsaved: false }; fields: Record<string, unknown> }
  | { kind: "dataset-item"; object: DatasetItem; context: ObjectViewContext; fields: Record<string, unknown> }
export type ObjectViewProps = ObjectViewInput & { /** Compatibility for previously saved renderers. */ trace: TraceViewData }
export function traceObjectViewInput(trace: TraceViewData): ObjectViewInput {
  return { kind: "trace", object: trace, context: { unsaved: false }, fields: {} }
}
export function objectViewPayload(input: ObjectViewInput, trace: TraceDetail | TraceViewData): ObjectViewProps {
  return { ...input, trace }
}
export { reactViewSchema as objectViewSchema, type ReactView as ObjectView, type ReactViewSummary as ObjectViewSummary } from "./react-views"
