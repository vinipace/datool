"use client"

import { useState } from "react"
import {
  FileInput,
  Layers,
  MousePointer2,
  PanelsTopLeft,
  Plus,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardAction } from "@/components/ui/card"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type { WidgetDefinition } from "@/src/lib/build/contracts"
import {
  widgetTemplates,
  type WidgetTemplate,
} from "@/src/lib/build/widget-templates"
import { WidgetPreview } from "./widget-preview"

export function WidgetTemplates({
  search,
  onClear,
  onUse,
}: {
  search: string
  onClear: () => void
  onUse: (definition: WidgetDefinition) => void
}) {
  const [preview, setPreview] = useState<WidgetTemplate | null>(null)
  const [stateName, setStateName] = useState("default")
  const templates = widgetTemplates.filter(({ category, definition }) =>
    `${category} ${definition.name} ${definition.description}`
      .toLowerCase()
      .includes(search.trim().toLowerCase())
  )
  return (
    <>
      <div className="space-y-6 pt-4 pb-6">
        {(["Sales", "Support", "E-commerce"] as const).map((category) => {
          const group = templates.filter(
            (template) => template.category === category
          )
          return group.length ? (
            <section
              key={category}
              aria-label={`${category} widget templates`}
              className="space-y-3"
            >
              <h2 className="text-sm font-medium">{category}</h2>
              <div className="grid gap-3 lg:grid-cols-2">
                {group.map((template) => {
                  const Icon =
                    template.id === "order-summary"
                      ? PanelsTopLeft
                      : template.id === "quick-choices"
                        ? MousePointer2
                        : FileInput
                  return (
                    <Card key={template.id}>
                      <CardAction
                        className="flex h-full items-start gap-4"
                        onClick={() => {
                          setStateName("default")
                          setPreview(template)
                        }}
                      >
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-foreground-muted">
                          <Icon className="size-5" aria-hidden />
                        </span>
                        <span className="min-w-0 space-y-1">
                          <span className="block text-sm font-medium">
                            {template.definition.name}
                          </span>
                          <span className="block text-sm leading-6 text-foreground-muted">
                            {template.definition.description}
                          </span>
                        </span>
                      </CardAction>
                    </Card>
                  )
                })}
              </div>
            </section>
          ) : null
        })}
        {!templates.length && (
          <div className="py-16 text-center">
            <Layers
              className="mx-auto mb-3 size-6 text-foreground-muted"
              aria-hidden
            />
            <p className="text-sm text-foreground-muted">
              No matching templates.
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-3"
              onClick={onClear}
            >
              Clear search
            </Button>
          </div>
        )}
      </div>
      {preview && (
        <Sheet
          open
          onOpenChange={(open) => {
            if (!open) setPreview(null)
          }}
        >
          <SheetContent className="sm:max-w-xl">
            <SheetHeader className="shrink-0 border-b border-border p-5">
              <span className="mb-2 w-fit rounded-md border border-border px-2 py-1 text-xs text-foreground-muted">
                {preview.category}
              </span>
              <SheetTitle>{preview.definition.name}</SheetTitle>
              <SheetDescription>
                {preview.definition.description}
              </SheetDescription>
              <p className="pt-2 text-xs leading-5 text-foreground-muted">
                Preview uses example data. Templates open as disabled drafts.
                Connect your own actions in Functions before enabling
                interactive widgets.
              </p>
            </SheetHeader>
            <div className="min-h-0 flex-1">
              <WidgetPreview
                key={preview.id}
                definition={preview.definition}
                selectedState={stateName}
                onStateChange={setStateName}
              />
            </div>
            <SheetFooter className="shrink-0 border-t border-border p-5">
              <Button
                onClick={() => {
                  onUse(structuredClone(preview.definition))
                  setPreview(null)
                }}
              >
                <Plus />
                Use template
              </Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      )}
    </>
  )
}
