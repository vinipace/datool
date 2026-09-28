"use client"

import { useMemo, useState } from "react"
import { WandSparkles } from "lucide-react"
import type { JsonObject } from "@/src/lib/tracer/contracts"
import { cn } from "@/lib/utils"
import { useMonacoEditor } from "./use-monaco-editor"
import { Button } from "./button"

/** Shared local Monaco editor. Models, diagnostics and workers stay scoped to the document. */
export function CodeEditor({
  value,
  onChange,
  language,
  label,
  className,
  schema,
  declarations,
  readOnly = false,
  showPrettify = false,
  autoSize = false,
  lineNumbers = true,
  variant = "default",
  tone = "default",
}: {
  value: string
  onChange: (value: string) => void
  language:
    | "javascript"
    | "python"
    | "json"
    | "yaml"
    | "ini"
    | "plaintext"
    | "mustache"
    | "markdown"
  label: string
  className?: string
  schema?: JsonObject | null
  declarations?: string
  readOnly?: boolean
  showPrettify?: boolean
  autoSize?: boolean
  lineNumbers?: boolean
  variant?: "default" | "embedded" | "snippet"
  tone?: "default" | "success" | "error"
}) {
  const [formatting, setFormatting] = useState(false)
  const [formatError, setFormatError] = useState<string | null>(null)
  const options = useMemo(
    () => ({
      lineNumbers: lineNumbers ? ("on" as const) : ("off" as const),
      ...(autoSize
        ? {
            scrollBeyondLastLine: false,
            scrollbar: {
              vertical: "hidden" as const,
              horizontal: "hidden" as const,
              verticalScrollbarSize: 0,
              horizontalScrollbarSize: 0,
              alwaysConsumeMouseWheel: false,
            },
            overviewRulerLanes: 0,
            overviewRulerBorder: false,
            hideCursorInOverviewRuler: true,
            renderLineHighlight: "none" as const,
          }
        : {}),
    }),
    [autoSize, lineNumbers]
  )
  const { container, editorRef, ready, error } = useMonacoEditor({
    value,
    onChange,
    language,
    label,
    schema,
    declarations,
    readOnly,
    autoSize,
    options,
  })

  return (
    <div
      className={cn(
        "relative flex min-w-0 flex-col",
        tone === "success" && "bg-success-background",
        tone === "error" && "bg-destructive-background",
        tone !== "default" &&
          "[&_.margin]:bg-transparent! [&_.monaco-editor]:bg-transparent! [&_.monaco-editor-background]:bg-transparent!",
        className
      )}
    >
      {showPrettify &&
        !readOnly &&
        (language === "javascript" || language === "json") && (
          <div
            className={cn(
              "flex shrink-0 justify-end",
              "absolute top-2 right-4 z-10"
            )}
          >
            <Button
              type="button"
              aria-label="Prettify"
              size="sm"
              variant="secondary"
              disabled={!ready}
              loading={formatting}
              className="rounded-full bg-background"
              onClick={async () => {
                const editor = editorRef.current
                const model = editor?.getModel()
                if (!editor || !model) return
                const version = model.getVersionId()
                const source = model.getValue()
                setFormatting(true)
                setFormatError(null)
                try {
                  const [{ format }, babel, estree] = await Promise.all([
                    import("prettier/standalone"),
                    import("prettier/plugins/babel"),
                    import("prettier/plugins/estree"),
                  ])
                  const formatted = await format(source, {
                    parser: language === "javascript" ? "babel" : "json",
                    plugins: [babel.default, estree.default],
                    tabWidth: 2,
                  })
                  if (model.isDisposed() || editorRef.current !== editor) return
                  if (model.getVersionId() !== version) {
                    setFormatError("Code changed while formatting. Try again.")
                    return
                  }
                  if (formatted !== source) {
                    editor.pushUndoStop()
                    editor.executeEdits("prettify", [
                      { range: model.getFullModelRange(), text: formatted },
                    ])
                    editor.pushUndoStop()
                  }
                  editor.focus()
                } catch {
                  setFormatError(
                    "Unable to format this code. Check its syntax and try again."
                  )
                } finally {
                  setFormatting(false)
                }
              }}
            >
              <WandSparkles className="size-3.5" />
            </Button>
          </div>
        )}
      <div
        className={cn(
          "relative flex min-h-0 flex-1 flex-col overflow-hidden",
          variant !== "embedded" &&
            "rounded-md border border-input focus-within:ring-2 focus-within:ring-ring",
          variant === "snippet" && "bg-input-background px-4"
        )}
      >
        <div
          ref={container}
          className={cn(
            "w-full",
            autoSize ? "min-h-12 shrink-0" : "min-h-0 flex-1"
          )}
        />
        {formatError && (
          <p
            role="alert"
            className="shrink-0 px-3 py-2 text-xs text-destructive"
          >
            {formatError}
          </p>
        )}
        {!ready && !error && (
          <div
            role="status"
            className="absolute inset-0 flex items-center justify-center bg-muted text-xs text-foreground-muted"
          >
            Loading editor…
          </div>
        )}
        {error ? (
          <p
            role="alert"
            className="absolute inset-0 bg-background p-3 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}
      </div>
    </div>
  )
}
