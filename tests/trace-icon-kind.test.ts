import { expect, test } from "bun:test"
import { getTraceIconKind } from "@/components/tracer/trace-icon-kind"

test("automatic AI SDK traces display the root function kind", () => {
  expect(
    getTraceIconKind({ attributes: {}, operation: "ai.generateText" })
  ).toBe("function")
  expect(getTraceIconKind({ attributes: {}, operation: "ai.streamText" })).toBe(
    "function"
  )
  expect(
    getTraceIconKind({
      attributes: {},
      operation: "ai.generateText.doGenerate",
    })
  ).toBe("llm")
  expect(getTraceIconKind({ attributes: {}, operation: "ai.toolCall" })).toBe(
    "tool"
  )
})

test("group membership never changes the recorded operation icon", () => {
  expect(
    getTraceIconKind({
      group: { type: "workflow", name: "Flow" },
      attributes: {},
      operation: "ai.generateText",
    })
  ).toBe("function")
  expect(
    getTraceIconKind({
      attributes: { "otel.name": "ai.generateText" },
      operation: "weather",
    })
  ).toBe("function")
  expect(getTraceIconKind({ attributes: {}, operation: "workflow.run" })).toBe(
    "workflow"
  )
})

for (const type of ["agent", "workflow"] as const) {
  test(`an explicit ${type} operation retains its own icon without a group`, () => {
    expect(
      getTraceIconKind({
        attributes: { "datool.span.kind": type },
        operation: "run",
      })
    ).toBe(type)
  })
}
