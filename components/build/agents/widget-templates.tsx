"use client"

import { useRef, useState } from "react"
import Image from "next/image"
import { Layers, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CardAction } from "@/components/ui/card"
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
  const previewTrigger = useRef<HTMLButtonElement | null>(null)
  const [preview, setPreview] = useState<WidgetTemplate | null>(null)
  const [stateName, setStateName] = useState("default")
  const templates = widgetTemplates.filter(({ category, definition }) =>
    `${category} ${definition.name} ${definition.description}`
      .toLowerCase()
      .includes(search.trim().toLowerCase())
  )
  return (
    <>
      <div className="@container/widget-gallery pt-4 pb-6">
        <div className="grid items-start gap-x-5 gap-y-6 @min-[560px]/widget-gallery:grid-cols-2 @min-[900px]/widget-gallery:grid-cols-3 @min-[1200px]/widget-gallery:grid-cols-4">
          {templates.map((template) => (
            <CardAction
              key={template.id}
              variant="preview"
              aria-label={`Preview ${template.definition.name}`}
              onClick={(event) => {
                previewTrigger.current = event.currentTarget
                setStateName("default")
                setPreview(template)
              }}
            >
              <span className="relative block aspect-[6/5] w-full overflow-hidden rounded-xl border border-border bg-muted transition-colors group-hover:border-foreground-muted">
                <Image
                  src={template.previewImage}
                  alt=""
                  fill
                  sizes="(max-width: 640px) 100vw, (max-width: 1100px) 50vw, (max-width: 1500px) 33vw, 25vw"
                  className="object-cover object-top"
                />
              </span>
              <span className="min-w-0 space-y-1 px-0.5">
                <span className="block text-sm font-medium">
                  {template.definition.name}
                </span>
                <span className="block text-xs leading-5 text-foreground-muted">
                  {template.definition.description}
                </span>
              </span>
            </CardAction>
          ))}
        </div>
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
          <SheetContent
            className="sm:max-w-xl"
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              previewTrigger.current?.focus()
            }}
          >
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
                  previewTrigger.current = null
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
