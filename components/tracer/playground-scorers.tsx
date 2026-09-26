"use client"

import { ScorerPicker } from "./scorer-picker"

export function PlaygroundScorers({
  value,
  onChange,
  disabled,
}: {
  value: string[]
  onChange: (ids: string[]) => void
  disabled: boolean
}) {
  return (
    <section
      aria-label="Automatic scoring"
      className="flex shrink-0 items-center gap-3 border-b border-border px-7 py-3"
    >
      <h3 className="shrink-0 text-sm">Scorers</h3>
      <ScorerPicker
        className="min-w-0 max-w-sm flex-1"
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        maxSelected={10}
      />
    </section>
  )
}
