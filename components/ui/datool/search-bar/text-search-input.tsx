"use client"

import { useRef } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SearchBarSurface } from "./search-bar-surface"

/** Immediate local text search with the same surface as structured filters. */
export function TextSearchInput({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string
  placeholder?: string
  value: string
  onChange: (value: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <SearchBarSurface onFocusInput={() => inputRef.current?.focus()}>
      <Input
        ref={inputRef}
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-7 min-w-0 flex-1 rounded-none border-0 bg-transparent px-1 py-1 text-xs placeholder:text-foreground-muted focus-visible:ring-0"
      />
      {value && (
        <Button
          type="button"
          variant="ghost-muted"
          size="icon-sm"
          className="size-7"
          aria-label="Clear search"
          title="Clear search"
          onClick={() => {
            onChange("")
            inputRef.current?.focus()
          }}
        >
          <X className="size-3.5" />
        </Button>
      )}
    </SearchBarSurface>
  )
}
