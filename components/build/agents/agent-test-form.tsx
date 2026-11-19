"use client"

import type { ReactNode } from "react"
import { ChevronDown } from "lucide-react"
import { AgentJourneyEditor } from "./agent-journey-editor"
import { AgentTestExpectedEditor } from "./agent-test-expected-editor"
import { journeyStepsToCode } from "@/src/lib/build/journey-code"
import { StructuredValueEditor } from "@/components/ui/structured-value-editor"
import { StructuredValueView } from "@/components/ui/structured-value-view"
import { Input } from "@/components/ui/input"
import { jsonDocument, type ItemDraft } from "@/src/lib/tracer/dataset-editor"
import type { DatasetItemPreview, JsonObject } from "@/src/lib/tracer/contracts"

export function AgentTestForm({
  input,
  draft,
  item,
  onChange,
  disabled,
  expected,
  metadata,
  children,
}: {
  input: JsonObject
  draft: ItemDraft
  item: DatasetItemPreview
  onChange: (draft: ItemDraft) => void
  disabled?: boolean
  expected?: ReactNode
  metadata?: ReactNode
  children?: ReactNode
}) {
  const journey =
    input.journey &&
    typeof input.journey === "object" &&
    !Array.isArray(input.journey)
      ? input.journey
      : {}
  const code =
    typeof journey.code === "string"
      ? journey.code
      : journeyStepsToCode(Array.isArray(journey.steps) ? journey.steps : [])
  const changeCode = (code: string) => {
    const { code: _code, steps: _steps, ...saved } = journey
    void _code
    void _steps
    onChange({
      ...draft,
      input: jsonDocument({
        ...input,
        journey: { ...saved, ...(code.trim() ? { code } : {}) },
      }),
    })
  }
  return (
    <AgentJourneyEditor
      input={input}
      onChange={(input) => onChange({ ...draft, input: jsonDocument(input) })}
      disabled={disabled}
      expected={
        <AgentTestExpectedEditor
          value={draft.expectedOutput}
          onChange={(expectedOutput) => onChange({ ...draft, expectedOutput })}
          code={code}
          onCodeChange={changeCode}
          disabled={disabled}
          jsonContent={expected}
        />
      }
      advanced={
        <details className="group/advanced border-t border-border pt-3 text-xs">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-foreground-muted [&::-webkit-details-marker]:hidden">
            <ChevronDown className="size-3.5 -rotate-90 group-open/advanced:rotate-0" />
            Advanced
          </summary>
          <div className="mt-3 space-y-4">
            <div className="space-y-2">
              <span>Input JSON</span>
              <StructuredValueEditor
                label="Row Input"
                value={draft.input}
                view="json"
                height="h-44"
                disabled={disabled}
                onChange={(input) => onChange({ ...draft, input })}
              />
            </div>
            <div
              className="space-y-2"
              data-dataset-field="metadata"
              tabIndex={-1}
            >
              <span>Metadata</span>
              {metadata ?? (
                <StructuredValueEditor
                  label="Row Metadata"
                  value={draft.metadata}
                  view="json"
                  height="h-44"
                  disabled={disabled || Boolean(item.omittedFields?.metadata)}
                  onChange={(metadata) => onChange({ ...draft, metadata })}
                />
              )}
            </div>
            <label className="grid gap-1.5">
              Source trace
              <Input
                aria-label="Source trace ID"
                value={draft.sourceTraceId}
                disabled={disabled}
                readOnly={Boolean(item.sourceSpanId)}
                placeholder="Trace ID"
                onChange={(event) =>
                  onChange({ ...draft, sourceTraceId: event.target.value })
                }
              />
            </label>
            {item.sourceSpanEvidence ? (
              <StructuredValueView
                value={{
                  input: item.sourceSpanEvidence.input,
                  observedOutput:
                    item.observedOutput ?? item.sourceSpanEvidence.output,
                }}
                view="json"
              />
            ) : null}
            {children}
          </div>
        </details>
      }
    />
  )
}
