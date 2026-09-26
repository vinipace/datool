import { expect, test } from "bun:test"
import { documentForValueView, jsonDocument, parseValueDocument, type ValueDocument } from "@/src/lib/tracer/dataset-editor"
import { availableValueViews, defaultValueView, formatValueView, resolveValueView, valueViews } from "@/src/lib/tracer/value-views"

test("changing presentation preserves the draft and its structured value", () => {
  const input = { question: "Where is my order?", options: [true, null, 3] }
  const source = Object.freeze({ format: "json" as const, text: JSON.stringify(input, null, 4) })
  for (const view of valueViews) {
    const shown = documentForValueView(source, view)
    expect(parseValueDocument(source)).toEqual(input)
    if (!shown.readOnly) expect(parseValueDocument(shown.document)).toEqual(input)
  }
  expect(documentForValueView(source, "json").document).toBe(source)
  expect(documentForValueView(source, "text").readOnly).toBe(true)
  expect(documentForValueView(source, "pretty").readOnly).toBe(true)
  expect(documentForValueView(source, "tree").readOnly).toBe(true)
})

test("Text can edit strings without converting objects, numbers or null", () => {
  const value = 'First line\n"second line"'
  const shown = documentForValueView(jsonDocument(value), "text")
  expect(shown).toEqual({ document: { format: "text", text: value }, readOnly: false })
  expect(parseValueDocument(documentForValueView(shown.document, "yaml").document)).toBe(value)
  for (const multiline of ["hello\n", "hello\n\n", "\nhello\n\n"]) {
    expect(parseValueDocument(documentForValueView(jsonDocument(multiline), "yaml").document)).toBe(multiline)
  }
  for (const structured of [{ value }, [value], 42, true, null]) {
    expect(documentForValueView(jsonDocument(structured), "text").readOnly).toBe(true)
  }
})

test("an editable draft keeps raw spacing and incomplete syntax", () => {
  const document: ValueDocument = { format: "yaml", text: "question: Test\n\n# still editing\n  " }
  expect(documentForValueView(document, "yaml").document).toBe(document)
  const invalid: ValueDocument = { format: "json", text: '{\n  "question":' }
  expect(documentForValueView(invalid, "json").document).toBe(invalid)
  for (const view of ["yaml", "text", "pretty", "tree", "llm", "llm-raw"] as const) {
    expect(() => documentForValueView(invalid, view)).toThrow()
  }
  expect(invalid.text).toBe('{\n  "question":')
})

test("message views require recognized payloads and fall back when a row changes type", () => {
  const messages = { messages: [{ role: "user", content: "**Hello**" }], model: "test" }
  expect(defaultValueView(messages)).toBe("llm")
  expect(defaultValueView([messages.messages])).toBe("llm")
  expect(defaultValueView([messages.messages, messages.messages])).toBe("json")
  expect(availableValueViews(messages)).toEqual(valueViews.filter(view => view !== "image"))
  expect(defaultValueView({ text: "Answer", toolCalls: [] })).toBe("llm")
  for (const value of [null, false, 0, [], {}, { text: "Ordinary field" }, [{ role: "user", content: "Hello" }, 42]]) {
    expect(availableValueViews(value)).not.toContain("llm")
    expect(availableValueViews(value)).not.toContain("llm-raw")
    expect(resolveValueView(value, "llm")).toBe("json")
    expect(resolveValueView(value, "yaml")).toBe("yaml")
  }
  expect(resolveValueView("**Hello**", "llm-raw")).toBe("text")
  expect(defaultValueView("")).toBe("text")
  expect(resolveValueView(messages, "tree")).toBe("tree")
})

test("message previews keep the complete original draft and remain read only", () => {
  const value = { messages: [{ role: "assistant", content: "**Done**" }], temperature: 0, metadata: { cached: false } }
  const source = Object.freeze({ format: "json" as const, text: JSON.stringify(value, null, 4) })
  for (const view of ["llm", "llm-raw"] as const) {
    const preview = documentForValueView(source, view)
    expect(preview.readOnly).toBe(true)
    expect(preview.document).toBe(source)
    expect(parseValueDocument(documentForValueView(preview.document, "yaml").document)).toEqual(value)
  }
})

test("table formats use the same values in compact and tall rows", () => {
  const value = { answer: "Yes", count: 2 }
  expect(formatValueView(value, "json", true)).toBe('{"answer":"Yes","count":2}')
  expect(formatValueView(value, "json")).toContain('\n  "answer"')
  expect(formatValueView(value, "yaml", true)).toBe('answer: Yes\ncount: 2\n')
  expect(formatValueView("hello\nworld", "text")).toBe("hello\nworld")
  expect(formatValueView(value, "pretty")).toBe(JSON.stringify(value, null, 2))
})
