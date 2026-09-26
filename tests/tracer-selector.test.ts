import { describe, expect, test } from "bun:test"

import { selectJson } from "@/components/tracer/format"

describe("saved-view selector preview", () => {
  const row = {
    result: { score: 1 },
    trace: {
      output: {
        citations: [{ title: "Only this citation title should be selected." }],
        answer: { text: "Only this answer text should be selected." },
      },
    },
  }

  test("resolves a narrow nested output selector", () => {
    expect(selectJson(row, "trace.output.answer.text")).toEqual({
      kind: "value",
      value: "Only this answer text should be selected.",
    })
  })

  test("marks malformed and prototype selectors invalid before save", () => {
    expect(selectJson(row, "trace..output").kind).toBe("invalid")
    expect(selectJson(row, "trace.__proto__.output").kind).toBe("invalid")
  })

  test("uses the server's numeric dot segment grammar for output arrays", () => {
    expect(selectJson(row, "trace.output.citations.0.title")).toEqual({
      kind: "value",
      value: "Only this citation title should be selected.",
    })
    expect(selectJson(row, "trace.output.citations.title").kind).toBe("missing")
  })

  test("keeps a missing field distinct from a present null value", () => {
    expect(selectJson(row, "result.reasoning")).toEqual({
      kind: "missing",
      segment: "reasoning",
      value: null,
    })
    expect(
      selectJson({ result: { reasoning: null } }, "result.reasoning")
    ).toEqual({
      kind: "value",
      value: null,
    })
  })
})
