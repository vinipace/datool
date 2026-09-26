import { expect, test } from "bun:test"
import {
  outputHash,
  referenceMatches,
  reviewAnnotationsSchema,
  type AnnotationReference,
} from "../src/lib/tracer/review-annotations"

const text = "Rain tomorrow. Rain tomorrow. ☔"
const reference: AnnotationReference = {
  traceId: "trace",
  spanId: "span",
  spanName: "Forecast",
  field: "output",
  view: "text",
  outputHash: await outputHash(text),
  exact: "Rain tomorrow.",
  prefix: "Rain tomorrow. ",
  suffix: " ☔",
  start: 15,
  end: 29,
}
test("annotation anchors distinguish repeated passages and reject changed output", async () => {
  expect(referenceMatches(text, reference)).toBe(true)
  expect(referenceMatches("Rain tomorrow. Sun tomorrow. ☔", reference)).toBe(
    false
  )
  expect(referenceMatches(text, { ...reference, start: 0, end: 14 })).toBe(
    false
  )
  expect(await outputHash(text + "changed")).not.toBe(reference.outputHash)
  expect(await outputHash(text)).toBe(reference.outputHash)
})
test("annotation inputs bound quotes, require comments and reject forged attribution", () => {
  const entry = {
    id: crypto.randomUUID(),
    reference,
    comment: "Compare with the tool.",
  }
  expect(reviewAnnotationsSchema.safeParse([entry]).success).toBe(true)
  for (const entries of [
    [entry, entry],
    [{ ...entry, author: { id: "someone-else" } }],
    [{ ...entry, comment: " " }],
    [{ ...entry, reference: { ...reference, end: 1 } }],
    [{ ...entry, reference: { ...reference, field: "custom" } }],
    [{ ...entry, reference: { ...reference, field: "metadata" } }],
  ]) {
    expect(reviewAnnotationsSchema.safeParse(entries).success).toBe(false)
  }
  expect(reviewAnnotationsSchema.safeParse([{ ...entry, reference: { ...reference, field: "input" } }]).success).toBe(true)
})
