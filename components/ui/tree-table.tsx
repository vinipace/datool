"use client"

import * as React from "react"
import { Plus } from "lucide-react"
import { Button } from "./button"

/** Shared tree-table interactions; indentation and drop state use semantic tokens. */
// eslint-disable-next-line react-refresh/only-export-components
export const treeTable = {
  row: "cursor-default data-[drop-target=true]:bg-selection data-[drop-target=true]:ring-1 data-[drop-target=true]:ring-inset data-[drop-target=true]:ring-ring data-[dragging=true]:opacity-40",
  selectionCell: "pr-2 pl-4 align-middle",
  nameCell: "pl-0",
  columnHeading: "h-10 border-r-0",
  heading: "pl-8",
  content: "relative flex min-h-10 min-w-0 items-center gap-2 py-1",
  label:
    "min-w-0 flex items-center !pl-7 w-full !pr-4  hover:underline justify-start gap-2 px-0 text-left select-none has-[>svg]:px-0 [&[draggable=true]]:cursor-grab [&[draggable=true]]:active:cursor-grabbing",
  inputContainer: "min-w-0 flex-1 pl-5",
  // The caret shares the label position: 20px offset + 1px border + 23px padding.
  input: "h-8 pl-[23px]",
}

const indentSize = 24

export function TreeIndent({
  depth,
  children,
}: React.PropsWithChildren<{ depth: number }>) {
  const visibleDepth = Math.min(depth, 12)
  return (
    <div
      data-slot="tree-indent"
      className={treeTable.content}
      style={{ paddingLeft: visibleDepth * indentSize }}
    >
      {Array.from({ length: visibleDepth }, (_, level) => (
        <span
          key={level}
          data-slot="tree-depth-guide"
          aria-hidden="true"
          className="pointer-events-none absolute -inset-y-px border-l border-border"
          style={{ left: level * indentSize + 20 }}
        />
      ))}
      {children}
    </div>
  )
}

export function TreeAddButton({
  label,
  onClick,
}: {
  label: string
  onClick: () => void
}) {
  return (
    <Button
      variant="ghost-muted"
      size="sm"
      className={treeTable.label}
      aria-label={label}
      onClick={onClick}
    >
      <span aria-hidden="true" />
      <Plus className="size-4 justify-self-center" />
      <span>Add</span>
    </Button>
  )
}
