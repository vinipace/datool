"use client"

import { CodeEditor } from "@/components/ui/code-editor"
import { scorerDeclarations } from "@/src/lib/tracer/scorer-typings"

export function ScorerCodeEditor(props: {
  value: string
  onChange: (value: string) => void
  language: "javascript" | "python" | "json"
  label: string
  className?: string
  showPrettify?: boolean
  toolbarPlacement?: "inside" | "above" | "floating"
}) {
  return (
    <CodeEditor
      {...props}
      declarations={
        props.language === "javascript" ? scorerDeclarations : undefined
      }
    />
  )
}
