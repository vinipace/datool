import { expect, test } from "bun:test"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { PlaygroundInputForm } from "@/components/tracer/playground-input-form"
import {
  initialAppInput,
  schemaDefault,
  updateInputProperty,
  usesJsonEditor,
} from "@/src/lib/playground/input-form"

test("schema defaults preserve types, nested required fields and leave optional values absent", () => {
  const schema = {
    type: "object",
    required: ["company", "enabled", "count"],
    properties: {
      company: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string", default: "Acme" } },
      },
      enabled: { type: "boolean" },
      count: { type: "integer", default: 0 },
      optional: { type: "string" },
      choice: { enum: [1, 2], default: 2 },
    },
  }
  expect(schemaDefault(schema)).toEqual({
    company: { name: "Acme" },
    enabled: false,
    count: 0,
    choice: 2,
  })
  const defaultInput = { enabled: true, optional: "value" }
  expect(initialAppInput(schema, defaultInput)).toEqual({
    company: { name: "Acme" },
    enabled: true,
    count: 0,
    choice: 2,
    optional: "value",
  })
  expect(initialAppInput(schema, defaultInput)).not.toBe(defaultInput)
  expect(updateInputProperty(defaultInput, "optional", undefined)).toEqual({
    enabled: true,
  })
  expect(defaultInput.optional).toBe("value")
})

test("renders scorer form sections with recursive fields, arrays and schema constraints", () => {
  const html = renderToStaticMarkup(
    <PlaygroundInputForm
      schema={{
        type: "object",
        required: ["context"],
        properties: {
          context: {
            type: "object",
            required: ["company"],
            properties: {
              company: { type: "string", minLength: 1 },
              score: { type: "integer", minimum: 0 },
            },
          },
          messages: {
            type: "array",
            items: {
              type: "object",
              properties: { content: { type: "string" } },
            },
          },
        },
      }}
      value={{ context: { company: "Acme" }, messages: [{ content: "Hello" }] }}
      onChange={() => {}}
    />
  )
  expect(html).toContain("<details open")
  expect(html).toContain('aria-label="context.company"')
  expect(html).toContain('minLength="1"')
  expect(html).toContain('type="number"')
  expect(html).toContain('aria-label="messages.1.content"')
  expect(html).toContain("Add messages item")
})

test("complex and open schemas keep JSON input available without losing fields", () => {
  expect(usesJsonEditor({ type: "object" })).toBe(true)
  expect(
    usesJsonEditor({ anyOf: [{ type: "string" }, { type: "null" }] })
  ).toBe(true)
  expect(
    usesJsonEditor({ type: "object", properties: { text: { type: "string" } } })
  ).toBe(false)
  const html = renderToStaticMarkup(
    <PlaygroundInputForm
      schema={{ type: "object" }}
      value={{ custom: [1, 2] }}
      onChange={() => {}}
    />
  )
  expect(html).toContain('aria-label="Input"')
  expect(html).toContain("custom")
})
