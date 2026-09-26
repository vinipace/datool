import { expect, test } from "bun:test"
import {
  changeInputFormat,
  inputDocument,
  parseInputDocument,
} from "@/src/lib/playground/input-document"

test("form, JSON and YAML round trips preserve structured input and scalar types", () => {
  const value = {
    company: "001",
    enabled: false,
    count: 0,
    nested: { absent: null },
    messages: [{ role: "user", content: "First\nSecond" }],
  }
  const form = inputDocument(value, "form")
  const json = changeInputFormat(form, "json")
  const yaml = changeInputFormat(json, "yaml")
  expect(parseInputDocument(json)).toEqual(value)
  expect(parseInputDocument(yaml)).toEqual(value)
  expect(changeInputFormat(yaml, "form")).toEqual(form)
})

test("edits in either code format become the form value without changing their types", () => {
  const yaml = {
    format: "yaml" as const,
    text: "company: example\nscore: 82\nactive: true\nissues:\n  - Improve speed\n",
  }
  expect(changeInputFormat(yaml, "form")).toEqual({
    format: "form",
    value: {
      company: "example",
      score: 82,
      active: true,
      issues: ["Improve speed"],
    },
  })
  expect(
    parseInputDocument({ format: "json", text: '{"enabled":false,"count":0}' })
  ).toEqual({ enabled: false, count: 0 })
})

test("invalid drafts cannot be converted or sent as the previous valid input", () => {
  const draft = { format: "json" as const, text: '{"company":' }
  expect(() => changeInputFormat(draft, "form")).toThrow()
  expect(draft.text).toBe('{"company":')
  expect(changeInputFormat(draft, "json")).toBe(draft)
  for (const text of ["", "null", "[]", "42", '"text"']) {
    expect(() => parseInputDocument({ format: "json", text })).toThrow(
      "Input must be an object"
    )
  }
  for (const text of [
    "- item",
    "score: .inf",
    "root: &root\n  child: *root",
    "key: one\nkey: two",
  ]) {
    expect(() => parseInputDocument({ format: "yaml", text })).toThrow()
  }
})
