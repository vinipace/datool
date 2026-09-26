import { z } from "zod"
import type { ReviewProvenance } from "./review-provenance"
import { valueViews } from "./value-views"
import type { TraceSummary } from "./contracts"
import type { ComputedColumn } from "./computed-columns"

const id = z.string().min(1).max(200)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const customFieldSchema = z
  .object({
    id,
    name: z.string().min(1).max(120),
    code: z.string().max(20000),
    mode: z.enum(["expression", "template"]),
    format: z.enum(["text", "markdown"]),
    value: z.string().max(100000),
    sourceHash: hash,
  })
  .strict()
export const annotationReferenceSchema = z
  .object({
    traceId: id,
    spanId: id.nullable(),
    spanName: z.string().max(1000),
    field: z.enum(["input", "output", "custom"]),
    customField: customFieldSchema.optional(),
    view: z.enum(valueViews),
    // Keep the persisted key for compatibility with existing output comments.
    outputHash: hash,
    exact: z.string().min(1).max(8000),
    prefix: z.string().max(64),
    suffix: z.string().max(64),
    start: z.number().int().nonnegative().max(10000000),
    end: z.number().int().positive().max(10000000),
  })
  .strict()
  .refine(
    (ref) =>
      ref.field === "custom"
        ? !!ref.customField && ref.spanId === null
        : ref.customField === undefined,
    "Invalid custom field reference."
  )
  .refine(
    (ref) => ref.end - ref.start === ref.exact.length,
    "Invalid annotation range."
  )

export const reviewAnnotationInputSchema = z
  .object({
    id: z.uuid(),
    reference: annotationReferenceSchema,
    comment: z.string().trim().min(1).max(4000),
  })
  .strict()
export const reviewAnnotationsSchema = z
  .array(reviewAnnotationInputSchema)
  .max(100)
  .refine(
    (entries) =>
      new Set(entries.map((entry) => entry.id)).size === entries.length,
    "Annotation IDs must be unique."
  )
export type AnnotationReference = z.infer<typeof annotationReferenceSchema>
export type ReviewAnnotationInput = z.infer<typeof reviewAnnotationInputSchema>
export type ReviewAnnotation = ReviewAnnotationInput & {
  provenance?: ReviewProvenance
  updatedBy?: ReviewProvenance
  author: { id: string; name: string; image: string | null }
  createdAt: string
  updatedAt: string
}

/** Fingerprint the captured value, independently of the selected display format. */
export async function outputHash(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

export function customFieldValue(column: ComputedColumn, value: string) {
  return {
    id: column.id,
    name: column.name,
    code: column.code,
    mode: column.mode,
    format: column.format ?? "text",
    value,
  }
}

/** The captured trace inputs to browser-computed fields, with stable key order. */
export function customFieldSource(trace: TraceSummary) {
  return {
    id: trace.id,
    name: trace.name,
    operation: trace.operation,
    input: trace.input,
    output: trace.output,
    attributes: trace.attributes,
    durationMs: trace.durationMs,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    status: trace.status,
    sessionId: trace.sessionId,
  }
}

export function annotationFieldLabel(reference: AnnotationReference) {
  return reference.field === "custom"
    ? reference.customField!.name
    : reference.field === "input"
      ? "Input"
      : "Output"
}

/** Never attach a quote to a different occurrence or silently move stale evidence. */
export function referenceMatches(text: string, reference: AnnotationReference) {
  return (
    text.slice(reference.start, reference.end) === reference.exact &&
    text.slice(
      Math.max(0, reference.start - reference.prefix.length),
      reference.start
    ) === reference.prefix &&
    text.slice(reference.end, reference.end + reference.suffix.length) ===
      reference.suffix
  )
}
