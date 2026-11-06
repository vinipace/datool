"use client"

import * as React from "react"
import { Trash2 } from "lucide-react"
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
}: {
  input: JsonObject
  onChange: (input: JsonObject) => void
  disabled?: boolean
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
    const { steps: _steps, ...saved } = journey
    void _steps
    onChange({
      ...input,
      ...inputPatch,
      channel: "web",
      journey: { ...saved, code, ...patch },
    })
  }
  const parsed = agentEvaluationInputSchema.safeParse(input)
  return (
    <fieldset
      disabled={disabled}
      className="min-w-0 space-y-4"
      aria-label="Agent test"
    >
      <label className="grid gap-1.5 text-xs">
        Test name
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
          onChange={(event) => change({}, { message: event.target.value })}
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
      <div className="space-y-2">
        <div className="text-xs font-medium" id="test-code-label">
          Test code
        </div>
        <p className="text-xs text-foreground-muted">
          Use Playwright-style locators and awaited assertions. Controls run in
          the current widget; clicks continue the conversation.
        </p>
        <CodeEditor
          label="Test code"
          language="javascript"
          value={code}
          onChange={(code) => change({ code })}
          declarations={journeyCodeDeclarations}
          readOnly={disabled}
          className="h-96"
        />
        <details className="text-xs">
          <summary className="cursor-pointer text-foreground-muted">
            Browser API
          </summary>
          <div className="mt-2 space-y-2 text-foreground-muted">
            <p>
              <code>page.getByRole</code>, <code>getByLabel</code>,{" "}
              <code>getByText</code>, <code>getByPlaceholder</code>,{" "}
              <code>getByTestId</code> and <code>locator</code> select widget
              controls. Use <code>first()</code>, <code>last()</code> or{" "}
              <code>nth()</code> to choose a match.
            </p>
            <p>
              Click, fill, select options, check controls, and read text, values
              or attributes. Use{" "}
              <code>await expect(locator).toBeVisible()</code>,{" "}
              <code>toHaveText</code>, <code>toHaveValue</code>,{" "}
              <code>toHaveAttribute</code> or <code>toHaveCount</code>. Value
              assertions support <code>toBe</code>, <code>toEqual</code> and{" "}
              <code>toContain</code>; <code>.not</code> is supported.
            </p>
            <p>
              <code>agent.sendMessage</code> continues the chat;{" "}
              <code>agent.expectText</code>, <code>agent.expectAction</code> and{" "}
              <code>agent.expectHandoff</code> check the response, submitted
              details and prefilled links. Group operations with{" "}
              <code>test.step(name, async () =&gt; &#123; … &#125;)</code>.
            </p>
            <p>
              Write JavaScript with async/await and string selectors, without
              imports. Include at least one assertion. Code runs in an isolated
              browser with a 30-second limit.
            </p>
          </div>
        </details>
      </div>
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
          Complete the test before running it: {parsed.error.issues[0]?.message}
        </Notice>
      ) : null}
    </fieldset>
  )
}
