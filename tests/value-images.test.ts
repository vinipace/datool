import { expect, test } from "bun:test"
import { imageValue } from "../src/lib/tracer/value-images"
import {
  availableValueViews,
  defaultValueView,
} from "../src/lib/tracer/value-views"
import {
  documentForValueView,
  jsonDocument,
} from "../src/lib/tracer/dataset-editor"
import { buildInspectorTree } from "../src/lib/tracer/trace-tree"
import type { TraceOverview } from "../src/lib/tracer/contracts"

test("explicit images preview safely without changing their stored value", () => {
  const value = {
    image: { url: "data:image/jpeg;base64,AAAA", alt: "A robot" },
    model: "image-model",
  }
  expect(imageValue(value)).toEqual(value.image)
  expect(defaultValueView(value)).toBe("image")
  expect(availableValueViews(value)).toContain("json")
  const original = jsonDocument(value)
  expect(documentForValueView(original, "image")).toEqual({
    document: original,
    readOnly: true,
  })
  for (const url of [
    "javascript:alert(1)",
    "data:image/svg+xml;base64,AAAA",
    "https://user:password@example.com/img",
  ])
    expect(imageValue({ image: { url } })).toBeNull()
  expect(imageValue({ url: "https://example.com/image.png" })).toBeNull()
})

test("adding the first scorer span keeps the invocation output reachable as the root", () => {
  const trace = {
    spans: [{ id: "score", parentId: null, kind: "score", startedAt: null }],
  } as unknown as TraceOverview
  expect(buildInspectorTree(trace).id).toBeNull()
  expect(buildInspectorTree(trace).children.map((node) => node.id)).toEqual([
    "score",
  ])
})
