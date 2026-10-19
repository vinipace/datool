"use client"

import * as React from "react"
import { RotateCcw } from "lucide-react"
import { Input } from "./input"
import { Button } from "./button"

/** Color picker plus editable hex value; incomplete typing never reaches CSS. */
export function ColorField({
  label,
  value,
  onChange,
  onReset,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  onReset?: () => void
}) {
  const [draft, setDraft] = React.useState<string | null>(null)
  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label={`${label} picker`}
        type="color"
        value={value}
        onInput={(event) => {
          setDraft(null)
          onChange(event.currentTarget.value)
        }}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-12 cursor-pointer p-1"
      />
      <Input
        aria-label={label}
        value={draft ?? value.toUpperCase()}
        maxLength={7}
        spellCheck={false}
        className="min-w-0 flex-1 font-mono"
        onChange={(event) => {
          const next = event.target.value
          setDraft(next)
          if (/^#[0-9a-fA-F]{6}$/.test(next)) onChange(next)
        }}
        onBlur={() => setDraft(null)}
      />
      {onReset ? (
        <Button
          variant="outline"
          size="icon"
          aria-label={`Reset ${label.toLowerCase()}`}
          onClick={() => {
            setDraft(null)
            onReset()
          }}
        >
          <RotateCcw className="size-4" />
        </Button>
      ) : null}
    </div>
  )
}
