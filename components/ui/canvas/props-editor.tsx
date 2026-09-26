"use client"

import { useId, useState } from "react"
import { Textarea } from "@/components/ui/textarea"
import type { JsonValue } from "./types"

/** Keeps incomplete JSON local; only complete objects reach the controlled canvas. */
export function PropsEditor<P extends Record<string, JsonValue>>({
  value,
  onChange,
}: {
  value: P
  onChange: (value: P) => void
}) {
  const id = useId()
  const source = JSON.stringify(value)
  const [draft, setDraft] = useState({
    source,
    text: JSON.stringify(value, null, 2),
    error: "",
  })

  // External updates should replace the draft, but our own updates retain formatting.
  if (draft.source !== source) {
    setDraft({ source, text: JSON.stringify(value, null, 2), error: "" })
  }

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-xs font-medium">
        Widget props (JSON)
      </label>
      <Textarea
        id={id}
        value={draft.text}
        spellCheck={false}
        className="min-h-64 resize-y font-mono text-xs"
        aria-invalid={!!draft.error}
        aria-describedby={`${id}-help`}
        onChange={(event) => {
          const text = event.target.value
          let next: P
          try {
            const parsed: unknown = JSON.parse(text)
            if (
              !parsed ||
              typeof parsed !== "object" ||
              Array.isArray(parsed)
            ) {
              throw new Error("Expected an object")
            }
            next = parsed as P
          } catch {
            setDraft({
              source,
              text,
              error:
                "Enter a valid JSON object. Your last valid changes are still applied.",
            })
            return
          }
          setDraft({ source: JSON.stringify(next), text, error: "" })
          onChange(next)
        }}
      />
      <p
        id={`${id}-help`}
        role={draft.error ? "alert" : undefined}
        className="text-xs text-foreground-muted"
      >
        {draft.error || "Valid changes apply automatically."}
      </p>
    </div>
  )
}
