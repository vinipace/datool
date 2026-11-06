"use client"

import * as React from "react"
import { ChevronDown, Trash2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import { CodeEditor } from "@/components/ui/code-editor"
import {
  journeyStepsToCode,
  journeyCodeDeclarations,
} from "@/src/lib/build/journey-code"
import { agentEvaluationInputSchema } from "@/src/lib/build/agent-journey"
import type { JsonObject, JsonValue } from "@/src/lib/tracer/contracts"

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {}
}

function JsonField({
  value,
  onChange,
  label,
}: {
  value: JsonValue
  onChange: (value: JsonValue) => void
  label: string
}) {
  const serialized = JSON.stringify(value, null, 2)
  const [draft, setDraft] = React.useState({
    source: serialized,
    text: serialized,
    error: "",
  })
  const current =
    draft.source === serialized
      ? draft
      : { source: serialized, text: serialized, error: "" }
  return (
    <div className="space-y-1">
      <Textarea
        aria-label={label}
        className="min-h-20 font-mono text-xs"
        value={current.text}
        onChange={(event) => {
          const text = event.target.value
          try {
            const next = JSON.parse(text) as JsonValue
            setDraft({ source: JSON.stringify(next, null, 2), text, error: "" })
            onChange(next)
          } catch {
            setDraft({ source: serialized, text, error: "Enter valid JSON." })
          }
        }}
      />
      {current.error ? (
        <p role="alert" className="text-xs text-destructive">
          {current.error}
        </p>
      ) : null}
    </div>
  )
}

export function AgentJourneyEditor({
  input,
  onChange,
  disabled,
  expected,
  advanced,
}: {
  input: JsonObject
  onChange: (input: JsonObject) => void
  disabled?: boolean
  expected?: React.ReactNode
  advanced?: React.ReactNode
}) {
  const journey = record(input.journey)
  const code =
    typeof journey.code === "string"
      ? journey.code
      : journeyStepsToCode(Array.isArray(journey.steps) ? journey.steps : [])
  const mocks = Array.isArray(journey.actionMocks)
    ? journey.actionMocks.map(record)
    : []
  const change = (patch: JsonObject, inputPatch: JsonObject = {}) => {
    const { steps: _steps, code: _code, ...saved } = journey
    const { code: nextCode = code, ...changes } = patch
    void _steps
    void _code
    onChange({
      ...input,
      ...inputPatch,
      channel: "web",
      journey: {
        ...saved,
        ...changes,
        ...(String(nextCode).trim() ? { code: nextCode } : {}),
      },
    })
  }

  const parsed = agentEvaluationInputSchema.safeParse(input)
  return (
    <fieldset
      disabled={disabled}
      className="min-w-0 space-y-5"
      aria-label="Agent test"
      data-dataset-field="input"
      tabIndex={-1}
    >
      <label className="grid gap-1.5 text-xs">
        Name
        <Input
          aria-label="Test name"
          placeholder="Name this test"
          value={String(journey.name ?? "")}
          maxLength={160}
          onChange={(event) => change({ name: event.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-xs">
        Message
        <Textarea
          aria-label="Customer message"
          placeholder="What does the customer say?"
          rows={3}
          className="min-h-20"
          value={String(input.message ?? "")}
          onChange={(event) => change({}, { message: event.target.value })}
        />
      </label>
      <details className="group/options border-t border-border pt-3 text-xs">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-foreground-muted [&::-webkit-details-marker]:hidden">
          <ChevronDown className="size-3.5 -rotate-90 group-open/options:rotate-0" />
          Options
        </summary>
        <div className="mt-3 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs">
              Language
              <Input
                aria-label="Test language"
                className="w-24"
                value={String(journey.locale ?? "en")}
                placeholder="pt-BR"
                onChange={(event) => change({ locale: event.target.value })}
              />
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={journey.required !== false}
                onChange={(event) => change({ required: event.target.checked })}
              />
              Required for publishing
            </label>
            <label className="flex items-center gap-2 text-xs">
              Preview
              <Select
                aria-label="Test preview width"
                value={String(journey.width ?? 390)}
                onChange={(event) =>
                  change({ width: Number(event.target.value) })
                }
              >
                <option value="390">Mobile</option>
                <option value="768">Tablet</option>
                <option value="1280">Desktop</option>
              </Select>
            </label>
          </div>
          <details className="space-y-3 text-xs">
            <summary className="cursor-pointer text-foreground-muted">
              Mock external actions
            </summary>
            {mocks.map((mock, index) => (
              <div
                key={index}
                className="space-y-2 rounded-md border border-border p-3"
              >
                <div className="flex gap-2">
                  <Input
                    aria-label={`Mock ${index + 1} action ID`}
                    placeholder="Action ID"
                    value={String(mock.actionId ?? "")}
                    onChange={(event) =>
                      change({
                        actionMocks: mocks.map((m, i) =>
                          i === index
                            ? { ...m, actionId: event.target.value }
                            : m
                        ),
                      })
                    }
                  />
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove mock ${index + 1}`}
                    onClick={() =>
                      change({
                        actionMocks: mocks.filter((_, i) => i !== index),
                      })
                    }
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
                <Select
                  aria-label={`Mock ${index + 1} outcome`}
                  value={mock.error !== undefined ? "error" : "response"}
                  onChange={(event) =>
                    change({
                      actionMocks: mocks.map((m, i) =>
                        i === index
                          ? {
                              actionId: m.actionId,
                              ...(event.target.value === "error"
                                ? { error: "Service unavailable" }
                                : { response: {} }),
                            }
                          : m
                      ),
                    })
                  }
                >
                  <option value="response">Test response</option>
                  <option value="error">Test error</option>
                </Select>
                {mock.error !== undefined ? (
                  <Input
                    aria-label={`Mock ${index + 1} error`}
                    value={String(mock.error)}
                    onChange={(event) =>
                      change({
                        actionMocks: mocks.map((m, i) =>
                          i === index ? { ...m, error: event.target.value } : m
                        ),
                      })
                    }
                  />
                ) : (
                  <JsonField
                    label={`Mock ${index + 1} response`}
                    value={mock.response ?? null}
                    onChange={(value) =>
                      change({
                        actionMocks: mocks.map((m, i) =>
                          i === index ? { ...m, response: value } : m
                        ),
                      })
                    }
                  />
                )}
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              disabled={mocks.length >= 50}
              onClick={() =>
                change({
                  actionMocks: [...mocks, { actionId: "", response: {} }],
                })
              }
            >
              Add test response
            </Button>
          </details>
        </div>
      </details>
      {advanced}
      {expected ?? (
        <details className="group/code border-t border-border pt-3 text-xs">
          <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
            <ChevronDown className="size-3.5 -rotate-90 text-foreground-muted group-open/code:rotate-0" />
            <span>Test code</span>
            <span className="ml-auto text-foreground-muted">Optional</span>
          </summary>
          <div className="mt-3 space-y-2">
            <CodeEditor
              label="Test code"
              language="javascript"
              value={code}
              onChange={(code) => change({ code })}
              declarations={journeyCodeDeclarations}
              readOnly={disabled}
              className="h-72"
            />
            <a
              href="/docs/evaluation/datasets#agent-interaction-cases"
              target="_blank"
              rel="noreferrer"
              className="text-xs text-foreground-muted hover:text-foreground hover:underline"
            >
              API reference
            </a>
          </div>
        </details>
      )}
      {!parsed.success && input.message ? (
        <Notice variant="warning" role="status">
          {parsed.error.issues[0]?.message}
        </Notice>
      ) : null}
    </fieldset>
  )
}
