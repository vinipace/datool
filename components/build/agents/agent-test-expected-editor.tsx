"use client"

import * as React from "react"
import { CodeEditor } from "@/components/ui/code-editor"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { journeyCodeDeclarations } from "@/src/lib/build/journey-code"
import {
  parseValueDocument,
  jsonDocument,
  type ValueDocument,
} from "@/src/lib/tracer/dataset-editor"
import type { JsonValue } from "@/src/lib/tracer/contracts"

/** JSON is reference data; browser code supplies its own assertions instead. */
export function AgentTestExpectedEditor({
  value,
  onChange,
  code,
  onCodeChange,
  disabled,
  jsonContent,
}: {
  value: ValueDocument
  onChange: (value: ValueDocument) => void
  code: string
  onCodeChange: (code: string) => void
  disabled?: boolean
  jsonContent?: React.ReactNode
}) {
  const [mode, setMode] = React.useState<"json" | "code">(
    code.trim() ? "code" : "json"
  )
  const [savedCode, setSavedCode] = React.useState(code)
  let parsed: JsonValue = null,
    error = ""
  try {
    parsed = parseValueDocument(value)
  } catch (reason) {
    error = reason instanceof Error ? reason.message : "Invalid JSON."
  }
  const json =
    value.format === "json"
      ? value.text === "null"
        ? ""
        : value.text
      : jsonDocument(parsed).text
  const changeMode = (value: string) => {
    const next = value as "json" | "code"
    if (next === mode) return
    if (next === "json") {
      setSavedCode(code)
      onCodeChange("")
    } else if (savedCode) onCodeChange(savedCode)
    setMode(next)
  }
  return (
    <Tabs
      value={mode}
      onValueChange={changeMode}
      className="space-y-2"
      data-dataset-field="expectedOutput"
      tabIndex={-1}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border">
        <span className="text-xs">
          Expected
          {mode === "code" ? (
            <span className="ml-2 text-foreground-muted">Optional</span>
          ) : null}
        </span>
        <TabsList
          variant="underline"
          size="sm"
          aria-label="Expected format"
          className="gap-4"
        >
          <TabsTrigger value="json" disabled={disabled}>
            JSON
          </TabsTrigger>
          <TabsTrigger value="code" disabled={disabled}>
            Code
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="json">
        {jsonContent ?? (
          <CodeEditor
            label="Expected JSON"
            language="json"
            value={json}
            onChange={(text) => onChange({ text, format: "json" })}
            readOnly={disabled}
            className="h-44"
          />
        )}
        {error ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </TabsContent>
      <TabsContent value="code">
        <CodeEditor
          label="Test code"
          language="javascript"
          value={code}
          onChange={(code) => {
            setSavedCode(code)
            onCodeChange(code)
          }}
          declarations={journeyCodeDeclarations}
          readOnly={disabled}
          className="h-72"
        />
      </TabsContent>
    </Tabs>
  )
}
