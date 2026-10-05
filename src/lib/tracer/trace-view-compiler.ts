import ts from "typescript"
import { compile } from "tailwindcss"
import { compile as compileMdx } from "@mdx-js/mdx"
import remarkGfm from "remark-gfm"
import { TRACE_VIEW_MODULES, type CompiledTraceView, type TraceViewModule, type ViewSourceFormat } from "./trace-view-contract"

/** Literal classes support conditional strings and static template branches. */
export function traceViewCandidates(source: string): string[] {
  const file = ts.createSourceFile("view.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const candidates = new Set<string>()
  function visit(node: ts.Node) {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      for (const part of node.text.split(/\s+/)) if (part) candidates.add(part)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return [...candidates]
}

export async function compileTraceView(source: string, theme: string, buildId: string, format: ViewSourceFormat = "react"): Promise<CompiledTraceView> {
  if (!source.trim() || source.length > 100_000) throw new Error("View code must contain 1–100,000 characters.")
  const componentSource = format === "mdx" ? String(await compileMdx(source, { format: "mdx", remarkPlugins: [remarkGfm] })) : source
  const file = ts.createSourceFile("view.tsx", componentSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const modules = new Set<TraceViewModule>()
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (specifier && ts.isStringLiteral(specifier)) {
        if (!TRACE_VIEW_MODULES.includes(specifier.text as TraceViewModule)) throw new Error(`Unsupported import: ${specifier.text}. Use ${TRACE_VIEW_MODULES.join(", ")}.`)
        modules.add(specifier.text as TraceViewModule)
      }
    }
    if (ts.isImportEqualsDeclaration(node) || (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)) throw new Error("Use static imports from the supported view modules.")
    ts.forEachChild(node, visit)
  }
  visit(file)
  const result = ts.transpileModule(componentSource, {
    fileName: "view.tsx", reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  })
  const errors = result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error) ?? []
  if (errors.length) throw new Error(errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"))
  const css = (await compile(theme)).build(traceViewCandidates(componentSource))
  return { buildId, source, format, javascript: result.outputText, css, modules: [...modules] }
}
