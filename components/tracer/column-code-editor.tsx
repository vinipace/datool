"use client"

import type * as Monaco from "monaco-editor"
import type {
  CompletionInfo,
  CompletionEntryDetails,
  QuickInfo,
} from "typescript"
import { Button } from "@/components/ui/button"
import {
  inTemplateExpression,
  rowDeclarations,
  templateJavaScript,
} from "@/src/lib/tracer/column-completions"
import type {
  ComputedColumn,
  ComputedRow,
  ComputedResource,
} from "@/src/lib/tracer/computed-columns"

import {
  useMonacoEditor,
  type MonacoEditorSetup,
} from "@/components/ui/use-monaco-editor"

const columnOptions: Monaco.editor.IStandaloneEditorConstructionOptions = {
  lineNumbers: "off",
  glyphMargin: false,
  fixedOverflowWidgets: false,
  wordBasedSuggestions: "off",
  suggest: { showInlineDetails: true, preview: true },
}

// Templates use a shadow JavaScript document for row-aware completions and hover.
function configureTemplate({
  runtime,
  model,
}: MonacoEditorSetup): Monaco.IDisposable | undefined {
  if (model.getLanguageId() !== "eval-template") return
  const { monaco, typescript } = runtime
  let disposed = false
  const shadow = monaco.editor.createModel(
    templateJavaScript(model.getValue()),
    "javascript",
    monaco.Uri.parse(`${model.uri.toString()}-expressions.js`)
  )
  const disposables: Monaco.IDisposable[] = [
    shadow,
    model.onDidChangeContent(() =>
      shadow.setValue(templateJavaScript(model.getValue()))
    ),
  ]
  const workerForShadow = async () =>
    (await typescript.getJavaScriptWorker())(shadow.uri)
  disposables.push(
    monaco.languages.registerCompletionItemProvider("eval-template", {
      triggerCharacters: [".", "[", "{", '"', "'"],
      async provideCompletionItems(active, position) {
        if (active !== model) return { suggestions: [] }
        if (
          !inTemplateExpression(model.getValue(), model.getOffsetAt(position))
        )
          return {
            suggestions: [
              {
                label: "{{ row… }}",
                detail: "Insert a JavaScript expression",
                insertText: "{{row.${1:metrics.cost}}}",
                insertTextRules:
                  monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                kind: monaco.languages.CompletionItemKind.Snippet,
                range: new monaco.Range(
                  position.lineNumber,
                  position.column,
                  position.lineNumber,
                  position.column
                ),
              },
            ],
          }
        const worker = await workerForShadow()
        const offset = model.getOffsetAt(position)
        const info = (await worker.getCompletionsAtPosition(
          shadow.uri.toString(),
          offset
        )) as CompletionInfo | undefined
        if (disposed) return { suggestions: [] }
        const word = model.getWordUntilPosition(position)
        return {
          suggestions: (info?.entries ?? []).map((entry) => {
            const start = entry.replacementSpan
              ? model.getPositionAt(entry.replacementSpan.start)
              : {
                  lineNumber: position.lineNumber,
                  column: word.startColumn,
                }
            const end = entry.replacementSpan
              ? model.getPositionAt(
                  entry.replacementSpan.start + entry.replacementSpan.length
                )
              : {
                  lineNumber: position.lineNumber,
                  column: word.endColumn,
                }
            return {
              label: entry.name,
              insertText: entry.insertText ?? entry.name,
              sortText: entry.sortText,
              kind:
                entry.kind === "method" || entry.kind === "function"
                  ? monaco.languages.CompletionItemKind.Function
                  : entry.kind === "var"
                    ? monaco.languages.CompletionItemKind.Variable
                    : monaco.languages.CompletionItemKind.Field,
              range: new monaco.Range(
                start.lineNumber,
                start.column,
                end.lineNumber,
                end.column
              ),
              // Monaco preserves these private fields when resolving an item.
              offset,
            }
          }),
        }
      },
      async resolveCompletionItem(item) {
        const offset = (
          item as Monaco.languages.CompletionItem & { offset: number }
        ).offset
        if (offset === undefined) return item
        const worker = await workerForShadow()
        const details = (await worker.getCompletionEntryDetails(
          shadow.uri.toString(),
          offset,
          typeof item.label === "string" ? item.label : item.label.label
        )) as CompletionEntryDetails | undefined
        return {
          ...item,
          detail: details?.displayParts?.map((part) => part.text).join(""),
          documentation: details?.documentation
            ?.map((part) => part.text)
            .join(""),
        }
      },
    })
  )
  disposables.push(
    monaco.languages.registerHoverProvider("eval-template", {
      async provideHover(active, position) {
        if (
          active !== model ||
          !inTemplateExpression(model.getValue(), model.getOffsetAt(position))
        )
          return null
        const worker = await workerForShadow()
        const info = (await worker.getQuickInfoAtPosition(
          shadow.uri.toString(),
          model.getOffsetAt(position)
        )) as QuickInfo | undefined
        if (!info || disposed) return null
        return {
          contents: [
            {
              value: `\`\`\`typescript\n${info.displayParts?.map((part) => part.text).join("")}\n\`\`\``,
            },
            {
              value:
                info.documentation?.map((part) => part.text).join("") ?? "",
            },
          ],
        }
      },
    })
  )

  return {
    dispose: () => {
      disposed = true
      for (const item of disposables.reverse()) item.dispose()
    },
  }
}

export function ColumnCodeEditor({
  value,
  mode,
  rows,
  resource = "eval",
  onChange,
}: {
  value: string
  mode: ComputedColumn["mode"]
  rows: ComputedRow[]
  resource?: ComputedResource
  onChange: (value: string) => void
}) {
  const { container, editorRef, ready, error } = useMonacoEditor({
    value,
    onChange,
    language: mode === "template" ? "eval-template" : "javascript",
    label: mode === "template" ? "Template code" : "JavaScript expression code",
    declarations: rowDeclarations(rows, resource),
    options: columnOptions,
    configure: configureTemplate,
  })
  const status = error ?? (ready ? "" : "Loading code editor…")

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-foreground-muted">
          Type <code>row.</code> to explore fields. Ctrl+Space opens
          suggestions.
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!!status}
          onClick={() => {
            editorRef.current?.focus()
            editorRef.current?.trigger(
              "button",
              "editor.action.triggerSuggest",
              {}
            )
          }}
        >
          Suggestions
        </Button>
      </div>
      {status ? (
        <p role="status" className="text-xs text-foreground-muted">
          {status}
        </p>
      ) : null}
      <div ref={container} className="h-44 rounded-md border border-input" />
    </div>
  )
}
