"use client"

import * as React from "react"
import { Plus, Trash2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import { agentEvaluationInputSchema } from "@/src/lib/build/agent-journey"
import type { JsonObject, JsonValue } from "@/src/lib/tracer/contracts"

const kinds = [
  ["click", "Click a button"],
  ["fill", "Fill a field"],
  ["select", "Select an option"],
  ["check", "Check or uncheck"],
  ["expect_text", "Check visible text"],
  ["expect_value", "Check a field value"],
  ["expect_selected", "Check a selected model"],
  ["expect_link", "Check a handoff link"],
  ["expect_action", "Check submitted details"],
  ["message", "Send another message"],
] as const

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
}: {
  input: JsonObject
  onChange: (input: JsonObject) => void
  disabled?: boolean
}) {
  const journey = record(input.journey)
  const steps = Array.isArray(journey.steps) ? journey.steps.map(record) : []
  const mocks = Array.isArray(journey.actionMocks)
    ? journey.actionMocks.map(record)
    : []
  const change = (patch: JsonObject) =>
    onChange({ ...input, channel: "web", journey: { ...journey, ...patch } })
  const changeStep = (index: number, patch: JsonObject) =>
    change({
      steps: steps.map((step, i) =>
        i === index ? { ...step, ...patch } : step
      ),
    })
  const parsed = agentEvaluationInputSchema.safeParse(input)
  return (
    <fieldset
      disabled={disabled}
      className="min-w-0 space-y-4"
      aria-label="Customer journey"
    >
      <label className="grid gap-1.5 text-xs">
        Journey name
        <Input
          value={String(journey.name ?? "")}
          maxLength={160}
          onChange={(event) => change({ name: event.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-xs">
        First customer message
        <Textarea
          value={String(input.message ?? "")}
          onChange={(event) =>
            onChange({ ...input, message: event.target.value })
          }
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs">
          Language
          <Input
            aria-label="Journey language"
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
          Preview width
          <Select
            aria-label="Journey preview width"
            value={String(journey.width ?? 390)}
            onChange={(event) => change({ width: Number(event.target.value) })}
          >
            <option value="390">Mobile</option>
            <option value="768">Tablet</option>
            <option value="1280">Desktop</option>
          </Select>
        </label>
      </div>
      <ol className="space-y-3" aria-label="Journey steps">
        {steps.map((step, index) => (
          <li
            key={index}
            className="space-y-3 rounded-md border border-border p-3"
          >
            <div className="flex items-center gap-2">
              <span className="text-xs text-foreground-muted">{index + 1}</span>
              <Select
                aria-label={`Step ${index + 1} type`}
                value={String(step.type)}
                onChange={(event) => {
                  const type = event.target.value
                  const next: JsonObject =
                    type === "expect_text"
                      ? { type, text: "" }
                      : type === "message"
                        ? { type, message: "" }
                        : type === "expect_action"
                          ? { type, actionId: "", input: {} }
                          : {
                              type,
                              name: "",
                              ...(["fill", "select", "expect_value"].includes(
                                type
                              )
                                ? { value: "" }
                                : {}),
                            }
                  change({
                    steps: steps.map((s, i) => (i === index ? next : s)),
                  })
                }}
              >
                {kinds.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Remove step ${index + 1}`}
                onClick={() =>
                  change({ steps: steps.filter((_, i) => i !== index) })
                }
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            {step.type === "expect_text" ? (
              <Input
                aria-label={`Step ${index + 1} expected text`}
                placeholder="Text the customer should see"
                value={String(step.text ?? "")}
                onChange={(event) =>
                  changeStep(index, { text: event.target.value })
                }
              />
            ) : step.type === "message" ? (
              <Textarea
                aria-label={`Step ${index + 1} customer message`}
                value={String(step.message ?? "")}
                onChange={(event) =>
                  changeStep(index, { message: event.target.value })
                }
              />
            ) : step.type === "expect_action" ? (
              <>
                <Input
                  aria-label={`Step ${index + 1} action ID`}
                  placeholder="Action ID"
                  value={String(step.actionId ?? "")}
                  onChange={(event) =>
                    changeStep(index, { actionId: event.target.value })
                  }
                />
                <JsonField
                  label={`Step ${index + 1} expected action input`}
                  value={step.input ?? {}}
                  onChange={(value) => changeStep(index, { input: value })}
                />
              </>
            ) : (
              <Input
                aria-label={`Step ${index + 1} button or field label`}
                placeholder="Exact button or field label"
                value={String(step.name ?? "")}
                onChange={(event) =>
                  changeStep(index, { name: event.target.value })
                }
              />
            )}
            {["fill", "select", "expect_value"].includes(String(step.type)) ? (
              <Input
                aria-label={`Step ${index + 1} value`}
                placeholder="Value"
                value={String(step.value ?? "")}
                onChange={(event) =>
                  changeStep(index, { value: event.target.value })
                }
              />
            ) : null}
            {step.type === "click" ? (
              <Select
                aria-label={`Step ${index + 1} control`}
                value={String(step.role ?? "button")}
                onChange={(event) =>
                  changeStep(index, { role: event.target.value })
                }
              >
                <option value="button">Button</option>
                <option value="link">Link</option>
                <option value="checkbox">Checkbox</option>
                <option value="radio">Radio option</option>
              </Select>
            ) : null}
            {step.type === "check" || step.type === "expect_selected" ? (
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={
                    (step.type === "check" ? step.checked : step.selected) !==
                    false
                  }
                  onChange={(event) =>
                    changeStep(index, {
                      [step.type === "check" ? "checked" : "selected"]:
                        event.target.checked,
                    })
                  }
                />
                Selected
              </label>
            ) : null}
            {step.type === "expect_link" ? (
              <div className="space-y-2">
                <Input
                  aria-label={`Step ${index + 1} destination`}
                  placeholder="Expected destination (optional)"
                  value={String(step.href ?? "")}
                  onChange={(event) => {
                    const { href: _href, ...rest } = steps[index]
                    void _href
                    change({
                      steps: steps.map((s, i) =>
                        i === index
                          ? {
                              ...rest,
                              ...(event.target.value
                                ? { href: event.target.value }
                                : {}),
                            }
                          : s
                      ),
                    })
                  }}
                />
                <Input
                  aria-label={`Step ${index + 1} handoff message`}
                  placeholder="Text required in the prefilled message (optional)"
                  value={String(step.message ?? "")}
                  onChange={(event) =>
                    changeStep(index, { message: event.target.value })
                  }
                />
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      <Button
        size="sm"
        variant="outline"
        disabled={steps.length >= 80}
        onClick={() =>
          change({
            steps: [...steps, { type: "click", role: "button", name: "" }],
          })
        }
      >
        <Plus className="size-3.5" />
        Add step
      </Button>
      <details className="space-y-3 text-xs">
        <summary className="cursor-pointer text-foreground-muted">
          Mock external actions
        </summary>
        <p className="text-foreground-muted">
          Widgets use their saved bindings. Other actions use these test
          responses and never contact the live service.
        </p>
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
                      i === index ? { ...m, actionId: event.target.value } : m
                    ),
                  })
                }
              />
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Remove mock ${index + 1}`}
                onClick={() =>
                  change({ actionMocks: mocks.filter((_, i) => i !== index) })
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
            change({ actionMocks: [...mocks, { actionId: "", response: {} }] })
          }
        >
          Add test response
        </Button>
      </details>
      {!parsed.success ? (
        <Notice variant="warning" role="status">
          Complete the journey before running it:{" "}
          {parsed.error.issues[0]?.message}
        </Notice>
      ) : null}
    </fieldset>
  )
}
