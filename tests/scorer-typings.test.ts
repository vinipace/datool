import { expect, test } from "bun:test"
import ts from "typescript"
import {
  scorerDeclarations,
  withScorerTypes,
} from "../src/lib/tracer/scorer-typings"

function completions(expression: string, before = "") {
  const code = withScorerTypes(
    `function evaluate({ trace, datasetItem }) {\n${before}\n${expression}/*cursor*/\n}`
  )
  const files: Record<string, string> = {
    "/scorer.js": code,
    "/scorer.d.ts": scorerDeclarations,
  }
  const options = {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
  }
  const service = ts.createLanguageService({
    getCompilationSettings: () => options,
    getScriptFileNames: () => Object.keys(files),
    getScriptVersion: () => "1",
    getScriptSnapshot: (path) => {
      const text = files[path] ?? ts.sys.readFile(path)
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => "/",
    getDefaultLibFileName: () => ts.getDefaultLibFilePath(options),
    fileExists: (path) => path in files || ts.sys.fileExists(path),
    readFile: (path) => files[path] ?? ts.sys.readFile(path),
  })
  try {
    return (
      service
        .getCompletionsAtPosition("/scorer.js", code.indexOf("/*cursor*/"), {})
        ?.entries.map((entry) => entry.name) ?? []
    )
  } finally {
    service.dispose()
  }
}

test("scorer JavaScript completes nested inputs and return fields", () => {
  expect(completions("trace.")).toContain("spans")
  expect(completions("trace.spans[0].")).toContain("kind")
  expect(completions("datasetItem?.")).toContain("expectedOutput")
  expect(completions("return { ")).toContain("score")
  expect(completions("return { ")).toContain("reason")
})

test("typing annotations preserve async JavaScript and existing annotations", () => {
  const code = "async function evaluate({ trace }) { return { score: 1 } }"
  expect(withScorerTypes(code)).toContain("async function evaluate")
  expect(withScorerTypes(withScorerTypes(code))).toBe(withScorerTypes(code))
})
