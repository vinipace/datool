"use client"

import { useMemo, useState } from "react"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import { CollectionFilterBar } from "@/components/tracer/collection-filter"
import { DashboardRenderer } from "@/components/tracer/dashboard-renderer"
import { useCollectionFilter } from "@/components/tracer/use-collection-filter"
import { dashboardFilterScope } from "@/src/lib/tracer/dashboard-queries"
import { agentOverviewWidgets } from "@/src/lib/tracer/dashboard-templates"

export function AgentOverview({ agentId }: { agentId: string }) {
  const [revision, setRevision] = useState(0)
  const [rangeEnd, setRangeEnd] = useState(() => Date.now())
  const widgets = useMemo(() => agentOverviewWidgets(agentId), [agentId])
  const filter = useCollectionFilter("dashboard", "startedAt >= -7d")
  const scoped = useMemo(() => {
    try {
      return {
        scope: dashboardFilterScope(
          filter.filter,
          rangeEnd,
          Intl.DateTimeFormat().resolvedOptions().timeZone
        ),
      }
    } catch (error) {
      return {
        error:
          error instanceof Error ? error.message : "Choose a valid date range.",
      }
    }
  }, [filter.filter, rangeEnd])

  return (
    <section
      aria-label="Agent overview"
      className="flex h-full min-h-0 flex-col gap-3 p-3"
    >
      <div className="flex shrink-0 items-center gap-2">
        <CollectionFilterBar
          {...filter}
          resource="dashboard"
          label="Filter agent overview dates"
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh agent overview"
          title="Refresh"
          onClick={() => {
            setRangeEnd(Date.now())
            setRevision((value) => value + 1)
          }}
        >
          <RefreshCw className="size-4" />
        </Button>
      </div>
      {scoped.error ? (
        <Notice variant="error" role="alert">
          {scoped.error}
        </Notice>
      ) : (
        <DashboardRenderer
          widgets={widgets}
          scope={scoped.scope}
          revision={revision}
        />
      )}
    </section>
  )
}
