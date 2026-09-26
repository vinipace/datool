"use client"

import * as React from "react"
import { AlignLeft, Copy } from "lucide-react"
import { Button } from "./button"
import { CodeEditor } from "./code-editor"
import { StructuredValueView } from "./structured-value-view"
import { ValueViewSelect } from "./value-view-select"
import { availableValueViews, isReadOnlyValueView, resolveValueView, type ValueView } from "@/src/lib/tracer/value-views"
import type { JsonObject, JsonValue } from "@/src/lib/tracer/contracts"
import {
  convertValueDocument,
  documentForValueView,
  parseValueDocument,
  type ValueDocument,
} from "@/src/lib/tracer/dataset-editor"

export function StructuredValueEditor({
  value,
  onChange,
  view: controlledView,
  onViewChange,
  label,
  schema,
  height = "h-44",
  autoSize = false,
  disabled = false,
}: {
  value: ValueDocument
  onChange: (value: ValueDocument) => void
  label: string
  view?: ValueView
  onViewChange?: (view: ValueView) => void
  schema?: JsonObject | null
  height?: string
  autoSize?: boolean
  disabled?: boolean
}) {
  const [localView, setLocalView] = React.useState<ValueView | null>(null)
  const requestedView = controlledView ?? localView ?? value.format
  const [actionError, setActionError] = React.useState("")
  const [copied, setCopied] = React.useState(false)
  let parsed: JsonValue = null
  let parseError = ""
  try {
    parsed = parseValueDocument(value)
  } catch (error) {
    parseError = error instanceof Error ? error.message : "Invalid value."
  }
  let presentation = { document: value, readOnly: false }
  let view = resolveValueView(parsed, requestedView)
  try {
    presentation = documentForValueView(value, view)
  } catch (error) {
    // Keep an invalid draft visible and editable in its original language.
    view = value.format
    parseError = error instanceof Error ? error.message : "Invalid value."
  }
  const shown = presentation.document
  const changeFormat = (format: ValueView) => {
    setActionError("")
    if (onViewChange) onViewChange(format)
    else setLocalView(format)
  }
  return (
    <div
      className="overflow-hidden rounded-lg border border-border bg-muted"
    >
      <div className="flex h-10 items-center justify-between gap-2 px-2">
        <ValueViewSelect
          label={`${label} format`}
          value={view}
          views={availableValueViews(parsed)}
          onChange={changeFormat}
          editing
          disabled={disabled}
        />
        <div className="flex items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            title="Format value"
            aria-label={`Format ${label}`}
            disabled={disabled || !!parseError || presentation.readOnly || shown.format === "text"}
            onClick={() => onChange(convertValueDocument(value, shown.format))}
          >
            <AlignLeft className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title={copied ? "Copied" : "Copy value"}
            aria-label={`Copy ${label}`}
            onClick={() => {
              void navigator.clipboard
                .writeText(shown.text)
                .then(() => setCopied(true))
                .catch(() => setActionError("Unable to copy this value."))
            }}
          >
            <Copy className="size-3.5" />
          </Button>
        </div>
      </div>
      {!isReadOnlyValueView(view) ? (
        <CodeEditor
          value={shown.text}
          readOnly={disabled || presentation.readOnly}
          onChange={(text) => {
            setActionError("")
            setCopied(false)
            onChange({ ...shown, text })
          }}
          language={shown.format === "text" ? "plaintext" : shown.format}
          label={label}
          schema={schema}
          autoSize={autoSize}
          variant="embedded"
          className={autoSize ? undefined : height}
        />
      ) : (
        <div className={`${autoSize ? "" : height} overflow-auto p-3`}>
          {!parseError && <div className="text-xs break-words whitespace-pre-wrap"><StructuredValueView value={parsed} view={view} /></div>}
        </div>
      )}
      {(parseError || actionError) && (
        <p
          role="alert"
          className="border-t border-border p-2 text-xs text-destructive"
        >
          {parseError || actionError}
        </p>
      )}
    </div>
  )
}
