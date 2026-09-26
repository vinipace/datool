"use client"

import * as React from "react"
import type { JsonValue } from "@/src/lib/tracer/contracts"
import {
  availableValueViews,
  resolveValueView,
  type ValueView,
} from "@/src/lib/tracer/value-views"
import { StructuredValueView } from "./structured-value-view"
import { ValueViewSelect } from "./value-view-select"

export function StructuredValueViewer({
  value,
  label,
  initialView,
  renderContent,
  inputValue,
}: {
  value: JsonValue
  label: string
  initialView?: ValueView
  renderContent?: (view: ValueView, children: React.ReactNode) => React.ReactNode
  inputValue?: JsonValue
}) {
  const [requestedView, setRequestedView] = React.useState<ValueView | undefined>(initialView)
  const view = resolveValueView(value, requestedView)
  const content = <StructuredValueView value={value} view={view} inputValue={inputValue} />
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center">
        <ValueViewSelect
          label={`${label} view type`}
          value={view}
          views={availableValueViews(value)}
          onChange={setRequestedView}
        />
      </div>
      <div className="py-2 text-xs leading-5 [overflow-wrap:anywhere] whitespace-pre-wrap text-foreground">
        {renderContent ? renderContent(view, content) : content}
      </div>
    </div>
  )
}
