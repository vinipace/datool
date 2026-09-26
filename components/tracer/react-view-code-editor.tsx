"use client"
import * as React from "react"
import {
  useMonacoEditor,
  type MonacoEditorSetup,
} from "@/components/ui/use-monaco-editor"
import { Notice } from "@/components/ui/notice"

function Editor({
  code,
  onChange,
  libraries,
}: {
  code: string
  onChange: (code: string) => void
  libraries: Record<string, string>
}) {
  const configure = React.useCallback(
    ({ runtime }: MonacoEditorSetup) => {
      const { typescript } = runtime
      typescript.typescriptDefaults.setCompilerOptions({
        jsx: typescript.JsxEmit.React,
        module: typescript.ModuleKind.CommonJS,
        moduleResolution: typescript.ModuleResolutionKind.NodeJs,
        target: typescript.ScriptTarget.ESNext,
        allowNonTsExtensions: true,
        strict: true,
        esModuleInterop: true,
        lib: ["esnext", "dom"],
        baseUrl: "file:///",
        paths: { "@/*": ["*"] },
        skipLibCheck: true,
      })
      const disposables = Object.entries(libraries).map(([uri, text]) =>
        typescript.typescriptDefaults.addExtraLib(text, uri)
      )
      return { dispose: () => disposables.forEach((item) => item.dispose()) }
    },
    [libraries]
  )
  const { container, ready, error } = useMonacoEditor({
    value: code,
    onChange,
    language: "typescript",
    label: "View code",
    configure,
    modelExtension: "tsx",
  })
  return (
    <div className="flex min-h-80 flex-1 flex-col">
      {!ready && !error && (
        <p role="status" className="p-3 text-sm text-foreground-muted">
          Loading editor…
        </p>
      )}
      {error && <Notice variant="error">{error}</Notice>}
      <div ref={container} className="min-h-80 flex-1" />
    </div>
  )
}
export function ReactViewCodeEditor(props: {
  code: string
  onChange: (code: string) => void
}) {
  const [libraries, setLibraries] = React.useState<Record<
    string,
    string
  > | null>(null)
  const [error, setError] = React.useState("")
  React.useEffect(() => {
    const controller = new AbortController()
    fetch("/trace-views/types.json", { signal: controller.signal })
      .then((response) => {
        if (!response.ok)
          throw new Error(
            "Could not load editor types. Close and reopen the editor to retry."
          )
        return response.json()
      })
      .then(setLibraries)
      .catch((error) => {
        if (!controller.signal.aborted) setError(String(error))
      })
    return () => controller.abort()
  }, [])
  if (error) return <Notice variant="error">{error}</Notice>
  return libraries ? (
    <Editor {...props} libraries={libraries} />
  ) : (
    <p role="status" className="p-3 text-sm text-foreground-muted">
      Loading editor…
    </p>
  )
}
