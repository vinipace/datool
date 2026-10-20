"use client"

import { ChevronDown, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { InspectorSection } from "@/components/ui/inspector-section"
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { ProcedureDefinition } from "@/src/lib/build/contracts"

export function StructuredSkillSteps({
  steps,
  onChange,
}: {
  steps: ProcedureDefinition["steps"]
  onChange: (steps: ProcedureDefinition["steps"]) => void
}) {
  return (
    <InspectorSection
      label={`Steps (${steps.length}/15)`}
      icon={<ChevronDown className="size-3.5" />}
    >
      <div className="space-y-2">
        {steps.map((step, index) => (
          <div
            key={step.id}
            className="rounded-md border border-border bg-background p-2"
          >
            <div className="flex items-center gap-2">
              <span className="w-6 text-center text-xs text-foreground-muted">
                {index + 1}
              </span>
              <Select
                aria-label={`Step ${index + 1} type`}
                value={step.kind}
                onChange={(event) => {
                  const kind = event.target
                    .value as ProcedureDefinition["steps"][number]["kind"]
                  const next = [...steps]
                  next[index] =
                    kind === "message"
                      ? { id: step.id, kind, content: "" }
                      : kind === "action"
                        ? { id: step.id, kind, actionId: "", input: {} }
                        : kind === "set_variable"
                          ? { id: step.id, kind, name: "", value: "" }
                          : kind === "wait"
                            ? { id: step.id, kind, seconds: 1 }
                            : { id: step.id, kind, actionId: "" }
                  onChange(next)
                }}
              >
                <option value="message">Message</option>
                <option value="action">Action</option>
                <option value="set_variable">Set variable</option>
                <option value="wait">Wait</option>
                <option value="handoff">Handoff</option>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove step ${index + 1}`}
                onClick={() =>
                  onChange(steps.filter((_, position) => position !== index))
                }
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            <div className="mt-2 pl-8">
              {step.kind === "message" ? (
                <Textarea
                  aria-label={`Step ${index + 1} message`}
                  rows={2}
                  autoSize
                  required
                  value={step.content}
                  onChange={(event) => {
                    const next = [...steps]
                    next[index] = { ...step, content: event.target.value }
                    onChange(next)
                  }}
                />
              ) : null}
              {step.kind === "action" || step.kind === "handoff" ? (
                <Input
                  aria-label={`Step ${index + 1} action ID`}
                  placeholder="action-id"
                  required
                  value={step.actionId}
                  onChange={(event) => {
                    const next = [...steps]
                    next[index] = { ...step, actionId: event.target.value }
                    onChange(next)
                  }}
                />
              ) : null}
              {step.kind === "set_variable" ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    aria-label={`Step ${index + 1} variable name`}
                    placeholder="variable"
                    required
                    value={step.name}
                    onChange={(event) => {
                      const next = [...steps]
                      next[index] = { ...step, name: event.target.value }
                      onChange(next)
                    }}
                  />
                  <Input
                    aria-label={`Step ${index + 1} value`}
                    value={String(step.value)}
                    onChange={(event) => {
                      const next = [...steps]
                      next[index] = { ...step, value: event.target.value }
                      onChange(next)
                    }}
                  />
                </div>
              ) : null}
              {step.kind === "wait" ? (
                <Input
                  aria-label={`Step ${index + 1} wait seconds`}
                  type="number"
                  min={0}
                  max={86400}
                  value={step.seconds}
                  onChange={(event) => {
                    const next = [...steps]
                    next[index] = {
                      ...step,
                      seconds: Number(event.target.value),
                    }
                    onChange(next)
                  }}
                />
              ) : null}
            </div>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={steps.length >= 15}
          onClick={() =>
            onChange([
              ...steps,
              { id: `step-${Date.now()}`, kind: "message", content: "" },
            ])
          }
        >
          <Plus className="size-3.5" />
          Add step
        </Button>
      </div>
    </InspectorSection>
  )
}
