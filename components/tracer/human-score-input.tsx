"use client"

import { useId } from "react"
import type { HumanScore } from "@/src/lib/tracer/human-scores"
import { ChoiceCard } from "@/components/ui/choice-card"
import { NumericScoreInput } from "@/components/ui/numeric-score-input"
import { Textarea } from "@/components/ui/textarea"

export function HumanScoreInput({
  definition,
  value,
  onChange,
  disabled,
}: {
  definition: HumanScore
  value: string | string[]
  onChange: (value: string | string[]) => void
  disabled?: boolean
}) {
  const groupId = useId()
  if (definition.type === "numeric")
    return (
      <NumericScoreInput
        label={definition.name}
        min={definition.min}
        max={definition.max}
        step={definition.step}
        value={String(value)}
        onValueChange={onChange}
        disabled={disabled}
      />
    )
  if (definition.type === "text")
    return (
      <Textarea
        aria-label={`${definition.name} answer`}
        autoSize
        rows={2}
        maxLength={definition.maxLength}
        placeholder="Write your answer…"
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
    )
  const selected = Array.isArray(value) ? value : value ? [value] : []
  return (
    <div
      role={definition.multiple ? "group" : "radiogroup"}
      aria-label={definition.name}
      className="space-y-2"
    >
      {definition.multiple && (
        <p className="text-xs text-foreground-muted">Select all that apply.</p>
      )}
      {definition.options.map((option) => (
        <ChoiceCard
          key={option.value}
          name={groupId}
          type={definition.multiple ? "checkbox" : "radio"}
          value={option.value}
          checked={selected.includes(option.value)}
          disabled={disabled}
          onChange={(event) =>
            onChange(
              definition.multiple
                ? event.target.checked
                  ? [...selected, option.value]
                  : selected.filter((item) => item !== option.value)
                : option.value
            )
          }
        >
          {option.label}
        </ChoiceCard>
      ))}
    </div>
  )
}
