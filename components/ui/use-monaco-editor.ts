"use client"

import * as React from "react"
import type * as Monaco from "monaco-editor"
import type { JsonObject } from "@/src/lib/tracer/contracts"

export type MonacoEditorSetup = {
  runtime: typeof import("@/components/tracer/monaco-runtime")
  editor: Monaco.editor.IStandaloneCodeEditor
  model: Monaco.editor.ITextModel
}

type EditorOptions = Monaco.editor.IStandaloneEditorConstructionOptions
type ConfigureEditor = (
  setup: MonacoEditorSetup
) => Monaco.IDisposable | undefined

/** Owns each editor's model, theme, controlled value and language resources. */
export function useMonacoEditor({
  value,
  onChange,
  language,
  label,
  readOnly = false,
  autoSize = false,
  declarations,
  schema,
  options,
  configure,
  modelExtension,
}: {
  value: string
  onChange: (value: string) => void
  language: string
  modelExtension?: string
  label: string
  readOnly?: boolean
  autoSize?: boolean
  declarations?: string
  schema?: JsonObject | null
  /** Keep options and configure stable; changing them recreates the editor. */
  options?: EditorOptions
  configure?: ConfigureEditor
}) {
  const container = React.useRef<HTMLDivElement>(null)
  const editorRef = React.useRef<Monaco.editor.IStandaloneCodeEditor | null>(
    null
  )
  const latest = React.useRef({ value, onChange, readOnly })
  const syncingValue = React.useRef(false)
  const configuration = React.useMemo(
    () => ({ language, label, options, configure, modelExtension }),
    [language, label, options, configure, modelExtension]
  )
  const [state, setState] = React.useState<{
    configuration: typeof configuration
    instance?: MonacoEditorSetup
    error?: string
  } | null>(null)
  const instance =
    state?.configuration === configuration ? state.instance : undefined
  const error = state?.configuration === configuration ? state.error : undefined
  const schemaText = schema ? JSON.stringify(schema) : ""

  React.useEffect(() => {
    latest.current.onChange = onChange
  }, [onChange])
  React.useEffect(() => {
    latest.current.value = value
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model || editor.getValue() === value) return
    const viewState = editor.saveViewState()
    const focused = editor.hasTextFocus()
    // External formatting preserves selection, scroll and undo history.
    syncingValue.current = true
    try {
      editor.pushUndoStop()
      // Controlled values must also update read-only editors; executeEdits
      // rejects those updates along with user edits.
      model.pushEditOperations(
        editor.getSelections(),
        [{ range: model.getFullModelRange(), text: value }],
        () => null
      )
      editor.pushUndoStop()
      if (viewState) editor.restoreViewState(viewState)
      if (focused) editor.focus()
    } finally {
      syncingValue.current = false
    }
  }, [value])
  React.useEffect(() => {
    latest.current.readOnly = readOnly
    editorRef.current?.updateOptions({ readOnly })
  }, [readOnly])

  React.useEffect(() => {
    let disposed = false
    let ownedEditor: Monaco.editor.IStandaloneCodeEditor | null = null
    const disposables: Monaco.IDisposable[] = []
    const release = () => {
      if (editorRef.current === ownedEditor) editorRef.current = null
      for (const item of disposables.splice(0).reverse()) item.dispose()
    }
    void import("@/components/tracer/monaco-runtime")
      .then((runtime) => {
        if (disposed || !container.current) return
        const { monaco } = runtime
        const { language, label, options, configure } = configuration
        const extension =
          configuration.modelExtension ??
          (language === "javascript" ? "js" : language)
        const model = monaco.editor.createModel(
          latest.current.value,
          language,
          monaco.Uri.parse(
            `file:///datool-editors/${crypto.randomUUID()}.${extension}`
          )
        )
        disposables.push(model)
        const editor = monaco.editor.create(container.current, {
          automaticLayout: true,
          quickSuggestions: { other: true, comments: false, strings: true },
          suggestOnTriggerCharacters: true,
          parameterHints: { enabled: true },
          minimap: { enabled: false },
          fontSize: 13,
          lineNumbers: "on",
          lineNumbersMinChars: 2,
          lineDecorationsWidth: 8,
          folding: false,
          scrollBeyondLastLine: false,
          wordWrap: "on",
          tabSize: 2,
          padding: { top: 12, bottom: 12 },
          scrollbar: { alwaysConsumeMouseWheel: false },
          ...options,
          model,
          ariaLabel: label,
          readOnly: latest.current.readOnly,
        })
        disposables.push(editor)
        ownedEditor = editor
        editorRef.current = editor
        const updateTheme = () => {
          const dark = document.documentElement.classList.contains("dark")
          const background = getComputedStyle(document.documentElement)
            .getPropertyValue("--input-background")
            .trim()
          monaco.editor.defineTheme("datool-editor", {
            base: dark ? "vs-dark" : "vs",
            inherit: true,
            rules: [],
            colors: {
              "editor.background": background,
              "editorGutter.background": background,
            },
          })
          monaco.editor.setTheme("datool-editor")
        }
        updateTheme()
        const observer = new MutationObserver(updateTheme)
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["class"],
        })
        disposables.push({ dispose: () => observer.disconnect() })
        const setup = { runtime, editor, model }
        const extensionResources = configure?.(setup)
        if (extensionResources) disposables.push(extensionResources)
        disposables.push(
          editor.onDidChangeModelContent(() => {
            if (!syncingValue.current)
              latest.current.onChange(editor.getValue())
          })
        )
        setState({ configuration, instance: setup })
      })
      .catch(() => {
        release()
        if (!disposed)
          setState({
            configuration,
            error: "Unable to load the code editor. Reload to try again.",
          })
      })
    return () => {
      disposed = true
      release()
    }
  }, [configuration])

  React.useEffect(() => {
    const editor = editorRef.current
    const element = container.current
    if (!autoSize || !instance || !editor || !element) return
    const resize = () => {
      const height = editor.getContentHeight()
      if (element.style.height === `${height}px`) return
      element.style.height = `${height}px`
      editor.layout()
    }
    const subscription = editor.onDidContentSizeChange(resize)
    resize()
    return () => {
      subscription.dispose()
      element.style.height = ""
    }
  }, [autoSize, instance])

  React.useEffect(() => {
    if (!instance || !declarations) return
    const library = instance.runtime.typescript.javascriptDefaults.addExtraLib(
      declarations,
      `${instance.model.uri.toString()}.d.ts`
    )
    return () => library.dispose()
  }, [instance, declarations])

  React.useEffect(() => {
    if (!instance || configuration.language !== "json" || !schemaText) return
    const defaults = instance.runtime.monaco.json.jsonDefaults
    const uri = instance.model.uri.toString()
    const entry = {
      uri: `${uri}.schema`,
      fileMatch: [uri],
      schema: JSON.parse(schemaText),
    }
    defaults.setDiagnosticsOptions({
      ...defaults.diagnosticsOptions,
      validate: true,
      schemas: [...(defaults.diagnosticsOptions.schemas ?? []), entry],
    })
    return () =>
      defaults.setDiagnosticsOptions({
        ...defaults.diagnosticsOptions,
        schemas: defaults.diagnosticsOptions.schemas?.filter(
          (item) => item.uri !== entry.uri
        ),
      })
  }, [instance, configuration.language, schemaText])

  return { container, editorRef, ready: !!instance, error }
}
