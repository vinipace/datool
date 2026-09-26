"use client"

import { useId, useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { PanelActionLabel } from "@/components/ui/panel-action-label"
import { RadioCard } from "@/components/ui/radio-card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { alertTemplates } from "@/src/lib/alerts/templates"

export function AlertCreateDialog({ projectSlug }: { projectSlug: string }) {
  const router = useRouter()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState("empty")

  function changeOpen(next: boolean) {
    if (next) setSelected("empty")
    setOpen(next)
  }

  function continueToEditor(event: FormEvent) {
    event.preventDefault()
    const query =
      selected === "empty" ? "" : `?template=${encodeURIComponent(selected)}`
    router.push(`/p/${encodeURIComponent(projectSlug)}/alerts/new${query}`)
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus />
          <PanelActionLabel>New alert</PanelActionLabel>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl overflow-hidden p-0">
        <form
          onSubmit={continueToEditor}
          className="flex max-h-[calc(100svh-2rem)] min-h-0 flex-col"
        >
          <DialogHeader className="shrink-0 px-5 pt-5 pb-4">
            <DialogTitle>New alert</DialogTitle>
            <DialogDescription>
              Start empty or choose a template. Configure your alert on the next
              page.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto px-5 pb-5">
            <fieldset className="space-y-3">
              <legend className="sr-only">Alert starting point</legend>
              <RadioCard
                name={`${id}-template`}
                value="empty"
                checked={selected === "empty"}
                onChange={() => setSelected("empty")}
                aria-label="Empty alert"
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <Plus aria-hidden="true" className="size-4" />
                  Empty alert
                </span>
                <span className="mt-1 block text-sm text-foreground-muted">
                  Start from scratch and configure your own condition.
                </span>
              </RadioCard>
              <p className="pt-2 text-xs font-medium text-foreground-muted">
                Template library
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {alertTemplates.map((template) => (
                  <RadioCard
                    key={template.id}
                    name={`${id}-template`}
                    value={template.id}
                    checked={selected === template.id}
                    onChange={() => setSelected(template.id)}
                    aria-label={template.label}
                  >
                    <span className="block text-sm font-medium">
                      {template.label}
                    </span>
                    <span className="mt-2 block text-sm text-foreground-muted">
                      {template.description}
                    </span>
                  </RadioCard>
                ))}
              </div>
            </fieldset>
          </div>
          <DialogFooter className="shrink-0 border-t border-border px-5 py-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => changeOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit">Continue</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
