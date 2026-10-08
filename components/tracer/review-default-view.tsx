"use client"

import * as React from "react"
import { Code2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Combobox } from "@/components/ui/combobox"
import { Notice } from "@/components/ui/notice"
import { toast } from "@/components/ui/toast"
import type { ReviewSessionDetail } from "@/src/lib/tracer/reviews"
import type { ReactViewSummary } from "@/src/lib/tracer/react-views"
import { reactViewsApi, tracerApi } from "./api"
import { useMutation, useRemote } from "./hooks"
import { useProjectScope } from "./project-scope-context"

export function ReviewDefaultView({
  session,
  onSaved,
  disabled,
}: {
  session: ReviewSessionDetail
  onSaved: () => void
  disabled?: boolean
}) {
  const scope = useProjectScope()
  const load = React.useCallback(
    async (signal: AbortSignal) => {
      const views: ReactViewSummary[] = []
      if (!scope) return views
      let cursor: string | undefined
      do {
        const page = await reactViewsApi.list(scope.projectId, cursor, signal)
        views.push(
          ...page.items.filter((view) =>
            (view.objectTypes ?? ["trace", "dataset-item"]).includes("trace")
          )
        )
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      return views
    },
    [scope]
  )
  const library = useRemote(load, [scope?.projectId])
  const mutation = useMutation()
  const busy = React.useRef(false)
  const [saved, setSaved] = React.useState(session)
  const current = saved.revision > session.revision ? saved : session
  return (
    <div className="min-w-0">
      <Combobox
        label="Default trace view"
        variant="toolbar"
        className="max-w-48"
        icon={<Code2 />}
        value={current.defaultObjectViewId ?? ""}
        placeholder="Default trace view"
        options={[
          { value: "", label: "Use trace inspector" },
          ...(library.data ?? []).map((view) => ({
            value: view.id,
            label: view.name,
          })),
          ...(current.defaultObjectViewId &&
          library.data &&
          !library.data.some((view) => view.id === current.defaultObjectViewId)
            ? [
                {
                  value: current.defaultObjectViewId,
                  label: "Unavailable view",
                },
              ]
            : []),
        ]}
        disabled={
          disabled ||
          !scope ||
          library.isLoading ||
          !!library.error ||
          mutation.isPending
        }
        onValueChange={(id) => {
          if (busy.current || id === (current.defaultObjectViewId ?? "")) return
          busy.current = true
          void mutation
            .run(() =>
              tracerApi.reviews.update(session.id, {
                expectedRevision: current.revision,
                defaultObjectViewId: id || null,
              })
            )
            .then((next) => {
              setSaved(next)
              onSaved()
            })
            .catch((error) =>
              toast.add({
                title: "Couldn’t save default trace view",
                description:
                  error instanceof Error ? error.message : "Try again.",
                type: "error",
              })
            )
            .finally(() => {
              busy.current = false
            })
        }}
      />
      {library.error && (
        <Notice variant="error">
          Couldn’t load trace views.{" "}
          <Button size="sm" variant="outline" onClick={library.refresh}>
            Retry views
          </Button>
        </Notice>
      )}
    </div>
  )
}
