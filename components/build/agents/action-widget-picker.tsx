"use client"

import { PanelsTopLeft } from "lucide-react"
import { useRemote } from "@/components/tracer/hooks"
import { Button } from "@/components/ui/button"
import { Combobox } from "@/components/ui/combobox"
import { Notice } from "@/components/ui/notice"
import { buildCall, buildOperations, listItems } from "../shared/build-api"
import type { WidgetRecord } from "@/src/lib/build/contracts"

export function ActionWidgetPicker({
  agentId,
  value,
  onValueChange,
}: {
  agentId: string
  value: string
  onValueChange: (value: string) => void
}) {
  const widgets = useRemote(
    (signal) =>
      buildCall<unknown>(
        buildOperations.listWidgets,
        { agentId },
        { signal }
      ).then(listItems<WidgetRecord>),
    [agentId]
  )
  const options = (widgets.data ?? []).map((widget) => ({
    value: widget.id,
    label: widget.definition.name,
    description: widget.definition.enabled
      ? widget.definition.description
      : "Disabled widget",
    descriptionBelow: true,
    descriptionWrap: true,
    disabled: !widget.definition.enabled,
    icon: PanelsTopLeft,
  }))
  const available = options.some((option) => !option.disabled)
  return (
    <div className="space-y-2">
      <Combobox
        label="Widget"
        value={value || null}
        options={options}
        selectedOption={
          value
            ? {
                value,
                label: widgets.isLoading
                  ? "Loading widget…"
                  : "Unavailable widget",
              }
            : undefined
        }
        onValueChange={onValueChange}
        disabled={widgets.isLoading || widgets.data === null}
        placeholder={
          widgets.isLoading ? "Loading widgets…" : "Choose a widget…"
        }
        searchPlaceholder="Search widgets…"
      />
      {widgets.error ? (
        <Notice role="alert" variant="error">
          <p>{widgets.error.message}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={widgets.refresh}
          >
            Retry
          </Button>
        </Notice>
      ) : widgets.data && !available ? (
        <Notice>
          Create or enable a widget in this agent’s Widgets section first.
        </Notice>
      ) : null}
    </div>
  )
}
