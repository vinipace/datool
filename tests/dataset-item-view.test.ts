import { expect, test } from "bun:test"
import { datasetItems } from "../.storybook/scenarios/datasets-evals/fixtures"
import { datasetItemViewTrace } from "../src/lib/tracer/dataset-item-view"
import { itemDraft, jsonDocument } from "../src/lib/tracer/dataset-editor"

test("saved trace views receive the current case values, including unsaved edits and falsy output", () => {
  const item = { ...datasetItems[0], observedOutput: "unreviewed output" }
  const draft = {
    ...itemDraft(item),
    input: jsonDocument({ question: "Edited question" }),
    expectedOutput: jsonDocument(false),
  }
  const view = datasetItemViewTrace(item, draft)
  expect(view.input).toEqual({ question: "Edited question" })
  expect(view.output).toBe(false)
  expect(view.attributes).toEqual(item.metadata)
  expect(view.spans).toEqual([])
  expect(view.id).toBe(item.id)
  expect(item.input).toEqual(datasetItems[0].input)
})

test("invalid drafts cannot silently render saved or unrelated values", () => {
  const item = datasetItems[0]
  expect(() =>
    datasetItemViewTrace(item, {
      ...itemDraft(item),
      metadata: jsonDocument([]),
    })
  ).toThrow("Metadata must be a JSON object")
  expect(() =>
    datasetItemViewTrace(item, {
      ...itemDraft(item),
      input: { format: "json", text: "{" },
    })
  ).toThrow()
  expect(
    datasetItemViewTrace(item, {
      ...itemDraft(item),
      expectedOutput: jsonDocument(null),
    }).output
  ).toBeNull()
})
