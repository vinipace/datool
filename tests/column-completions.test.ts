import { describe, expect, test } from "bun:test"
import ts from "typescript"
import {
  inferredType,
  inTemplateExpression,
  rowDeclarations,
  templateJavaScript,
} from "../src/lib/tracer/column-completions"
import type { ComputedResource, ComputedRow, EvalTableRow } from "../src/lib/tracer/computed-columns"
import type { DatasetItem } from "../src/lib/tracer/contracts"

const row: EvalTableRow = {
  id: "target",
  datasetItemId: null,
  expectedOutput: "Sunny",
  results: [],
  trace: {
    id: "trace",
    name: "Weather",
    operation: "weather",
    attributes: { metrics: { costUsd: 0.00398075 } },
    durationMs: 100,
    endedAt: null,
    startedAt: "2026-09-07",
    status: "completed",
    input: "Weather?",
    output: "Sunny",
    sessionId: null,
  },
}

function suggestions(code: string, rows: ComputedRow[] = [row], resource: ComputedResource = "eval") {
  const files = new Map([
    ["/eval.js", code],
    ["/row.d.ts", rowDeclarations(rows, resource)],
  ])
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    target: ts.ScriptTarget.ESNext,
  }
  const service = ts.createLanguageService({
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: () => "1",
    getCompilationSettings: () => options,
    getCurrentDirectory: () => "/",
    getDefaultLibFileName: () => ts.getDefaultLibFilePath(options),
    getScriptSnapshot: (path) => {
      const text = files.get(path) ?? ts.sys.readFile(path)
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    fileExists: (path) => files.has(path) || ts.sys.fileExists(path),
    readFile: (path) => files.get(path) ?? ts.sys.readFile(path),
  })
  try {
    return (
      service
        .getCompletionsAtPosition("/eval.js", code.length, {})
        ?.entries.map((entry) => entry.name) ?? []
    )
  } finally {
    service.dispose()
  }
}

describe("column autocomplete", () => {
  test("offers group identity and aggregate metrics even before performance rows load", () => {
    expect(suggestions("row.", [], "performance")).toContain("groupType")
    expect(suggestions("row.", [], "performance")).toContain("version")
    expect(suggestions("row.metrics.", [], "performance")).toContain("completedCount")
    expect(suggestions("row.metrics.", [], "performance")).toContain("reportedCostUsd")
    expect(suggestions("row.", [], "performance")).not.toContain("trace")
    expect(suggestions("row.metrics.", [], "performance")).not.toContain("cost")
  })
  test("offers native dataset fields and nested keys, including an empty dataset", () => {
    const item: DatasetItem = {
      id: "item", datasetId: "dataset", input: { question: "Where?" }, expectedOutput: { answer: "Here." },
      metadata: { locale: "en" }, sourceTraceId: null, createdAt: "2026-09-11", updatedAt: "2026-09-11",
    }
    expect(suggestions("row.", [item], "dataset")).toContain("metadata")
    expect(suggestions("row.input.", [item], "dataset")).toContain("question")
    expect(suggestions("row.expectedOutput.", [item], "dataset")).toContain("answer")
    expect(suggestions("row.metadata.", [item], "dataset")).toContain("locale")
    expect(suggestions("row.", [], "dataset")).toContain("expectedOutput")
    expect(suggestions("row.", [], "dataset")).not.toContain("metrics")
  })
  test("discovers known fields, missing metrics and JavaScript methods", () => {
    expect(suggestions("row.")).toContain("expectedOutput")
    expect(suggestions("row.metrics.")).toContain("reasoningTokens")
    expect(suggestions("row.metrics.cost.")).toContain("toFixed")
    expect(suggestions("row.results.")).toContain("map")
    expect(suggestions("row.results[0].")).toContain("evaluatorName")
    expect(suggestions("row.metrics.", [])).toContain("cost")
  })
  test("merges custom fields from later rows and nested array elements", () => {
    const rows = [
      row,
      {
        ...row,
        trace: {
          ...row.trace,
          input: { city: "Rio", nested: [{ a: 1 }, { b: true }] },
          attributes: { metrics: { latency: 24 } },
        },
      },
    ]
    expect(suggestions("row.metrics.", rows)).toContain("latency")
    expect(inferredType([{ nested: [{ a: 1 }, { b: true }] }])).toContain(
      '"b"?'
    )
  })
  test("preserves template offsets and excludes literal text from JavaScript", () => {
    const text = "R${{row.metrics.cost}}\nTokens: {{row.metrics."
    const shadow = templateJavaScript(text)
    expect(shadow.length).toBe(text.length)
    expect(shadow.indexOf("row.metrics.")).toBe(text.indexOf("row.metrics."))
    expect(shadow.split("\n")[0].length).toBe(text.split("\n")[0].length)
    expect(suggestions(shadow)).toContain("totalTokens")
    expect(inTemplateExpression(text, text.length)).toBe(true)
    expect(inTemplateExpression(text, text.indexOf("Tokens"))).toBe(false)
  })
  test("escapes unusual property names without including source values", () => {
    const type = inferredType([{ "cost.usd": 1, 'odd"key': "secret-value" }])
    expect(type).toContain('"cost.usd": number')
    expect(type).toContain('"odd\\"key": string')
    expect(type).not.toContain("secret-value")
  })
})
