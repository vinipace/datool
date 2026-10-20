import {
  transpileModule,
  JsxEmit,
  ModuleKind,
  ScriptTarget,
  DiagnosticCategory,
  flattenDiagnosticMessageText,
} from "typescript"

/** Syntax compilation only. Executable widget code runs exclusively in the sandbox. */
export function compileWidgetCode(source: string): string {
  const code = source.trim().startsWith("<")
    ? `export default function Widget({ data }) { return (${source}); }`
    : source
  return compileModule(code, "widget.jsx")
}

export function compileWidgetSchema(source: string): string {
  return compileModule(source, "schema.js")
}

function compileModule(code: string, fileName: string): string {
  const result = transpileModule(code, {
    fileName,
    compilerOptions: {
      jsx: JsxEmit.React,
      module: ModuleKind.CommonJS,
      target: ScriptTarget.ES2020,
      allowJs: true,
      esModuleInterop: true,
    },
    reportDiagnostics: true,
  })
  const error = result.diagnostics?.find(
    (item) => item.category === DiagnosticCategory.Error
  )
  if (error) {
    const position = error.file?.getLineAndCharacterOfPosition(error.start ?? 0)
    throw new Error(
      `${position ? `Line ${position.line + 1}: ` : ""}${flattenDiagnosticMessageText(error.messageText, "\n")}`
    )
  }
  if (!/exports\.default\s*=/.test(result.outputText)) {
    throw new Error(
      fileName === "schema.js"
        ? "Export a default Zod schema."
        : "Export a default React component, or start with a JSX element."
    )
  }
  return result.outputText
}
