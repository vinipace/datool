"use client"

import * as React from "react"
import { Search, SlidersHorizontal } from "lucide-react"
import { buildApi, asList } from "@/components/build/operations/build-api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"
import { Switch } from "@/components/ui/switch"
import { useRemote } from "@/components/tracer/hooks"
import { InfiniteScroll } from "@/components/tracer/infinite-scroll"
import type { ActionRecord } from "@/src/lib/build/contracts"
import type { IntegrationTool } from "@/src/lib/build/integrations"

const TOOL_BATCH_SIZE = 12

/** The stored action remains the runtime owner; this is its integration-facing control. */
export function IntegrationTools({
  agentId,
  connectionId,
  connectionLabel,
  onChanged,
  onEdit,
}: {
  agentId: string
  connectionId: string
  connectionLabel: string
  onChanged?: () => void
  onEdit?: (record: ActionRecord) => void
}) {
  const actions = useRemote(
    (signal) =>
      buildApi
        .call<unknown>("build_list_actions", { agentId }, signal)
        .then(asList<ActionRecord>),
    [agentId]
  )
  const tools = useRemote(
    (signal) =>
      buildApi.call<IntegrationTool[]>(
        "build_list_app_tools",
        { connectionId },
        signal
      ),
    [connectionId]
  )
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [search, setSearch] = React.useState("")
  const [filter, setFilter] = React.useState<"all" | "enabled" | "disabled">(
    "all"
  )
  const [visibleCount, setVisibleCount] = React.useState(TOOL_BATCH_SIZE)
  const records = (actions.data ?? []).filter(
    (item) =>
      item.definition.type === "integration" &&
      item.definition.connectionId === connectionId
  )
  const allRows = [
    ...records.map((record) => ({
      key: record.id,
      record,
      tool: tools.data?.find(
        (tool) =>
          record.definition.type === "integration" &&
          tool.slug === record.definition.toolSlug
      ),
    })),
    ...(tools.data ?? [])
      .filter(
        (tool) =>
          !records.some(
            (record) =>
              record.definition.type === "integration" &&
              record.definition.toolSlug === tool.slug
          )
      )
      .map((tool) => ({ key: tool.slug, record: undefined, tool })),
  ]
  const enabledCount = allRows.filter(
    ({ record }) => record?.definition.enabled
  ).length
  const rows = allRows.filter(({ record, tool }) => {
    const enabled = record?.definition.enabled ?? false
    if (filter === "enabled" && !enabled) return false
    if (filter === "disabled" && enabled) return false
    return `${record?.definition.name ?? tool?.name ?? ""} ${record?.definition.description ?? tool?.description ?? ""}`
      .toLowerCase()
      .includes(search.trim().toLowerCase())
  })
  const visibleRows = rows.slice(0, visibleCount)
  const loaded =
    !actions.isLoading && !tools.isLoading && !actions.error && !tools.error

  async function setEnabled(
    record: ActionRecord | undefined,
    tool: IntegrationTool | undefined,
    enabled: boolean
  ) {
    if (pending || (!record && !tool)) return
    setPending(true)
    setError(null)
    try {
      const id = record?.id ?? `integration_${crypto.randomUUID()}`
      const definition = record
        ? { ...record.definition, enabled }
        : {
            id,
            type: "integration",
            name: `${connectionLabel}: ${tool!.name}`.slice(0, 160),
            description: tool!.description.slice(0, 2000),
            connectionId,
            toolSlug: tool!.slug,
            inputSchema: tool!.inputSchema,
            enabled,
          }
      await buildApi.call("build_save_action", {
        agentId,
        id,
        slug: record?.slug ?? id,
        definition,
        ...(record ? { expectedRevision: record.revision } : {}),
      })
      onChanged?.()
      actions.refresh()
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not update this tool."
      )
      actions.refresh()
    } finally {
      setPending(false)
    }
  }

  return (
    <section aria-label={`Tools for ${connectionLabel}`} className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-base font-semibold">Tools</h3>
          <p className="text-sm text-foreground-muted">
            Choose what this agent can use.
          </p>
        </div>
        {loaded && (
          <p className="text-sm text-foreground-muted" role="status">
            <span className="font-medium text-foreground">{enabledCount}</span>{" "}
            of {allRows.length} enabled
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-foreground-muted"
          />
          <Input
            aria-label={`Search tools for ${connectionLabel}`}
            placeholder="Search tools"
            className="pl-9"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setVisibleCount(TOOL_BATCH_SIZE)
            }}
          />
        </div>
        <div
          role="group"
          aria-label="Filter tools"
          className="flex items-center gap-1 rounded-md bg-muted p-1"
        >
          {(
            [
              ["all", "All"],
              ["enabled", "Enabled"],
              ["disabled", "Disabled"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? "secondary" : "ghost-muted"}
              aria-pressed={filter === value}
              onClick={() => {
                setFilter(value)
                setVisibleCount(TOOL_BATCH_SIZE)
              }}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
      {error && (
        <Notice role="alert" variant="error">
          {error}
        </Notice>
      )}
      {(actions.error || tools.error) && (
        <Notice role="alert" variant="error">
          {actions.error?.message ?? tools.error?.message}{" "}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              actions.refresh()
              tools.refresh()
            }}
          >
            Retry tools
          </Button>
        </Notice>
      )}
      {(actions.isLoading || tools.isLoading) && (
        <p role="status" className="py-4 text-sm text-foreground-muted">
          Loading tools…
        </p>
      )}
      {loaded && rows.length === 0 && (
        <div className="rounded-md bg-surface-row px-4 py-8 text-center text-sm text-foreground-muted">
          {search || filter !== "all"
            ? "No tools match your search or filter."
            : "No tools available for this connection."}
        </div>
      )}
      <ul aria-label="Integration tools" className="space-y-0.5">
        {visibleRows.map(({ key, record, tool }) => {
          const name = record?.definition.name ?? tool?.name ?? "Tool"
          const prefix = `${connectionLabel}: `
          const displayName = name.startsWith(prefix)
            ? name.slice(prefix.length)
            : name
          const description =
            record?.definition.description ?? tool?.description
          return (
            <li
              key={key}
              className="flex min-w-0 items-center gap-3 rounded-md bg-surface-row px-3 py-2.5 transition-colors hover:bg-surface-row-hover"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={displayName}>
                  {displayName}
                </p>
                {description && (
                  <p
                    className="truncate text-xs text-foreground-muted"
                    title={description}
                  >
                    {description}
                  </p>
                )}
              </div>
              {record && onEdit && (
                <Button
                  size="icon-sm"
                  variant="ghost-muted"
                  aria-label={`Settings for ${name}`}
                  title={`Settings for ${displayName}`}
                  disabled={pending}
                  onClick={() => onEdit(record)}
                >
                  <SlidersHorizontal aria-hidden />
                </Button>
              )}
              <Switch
                aria-label={`Enable ${name}`}
                checked={record?.definition.enabled ?? false}
                disabled={
                  pending ||
                  actions.isRefreshing ||
                  Boolean(actions.error) ||
                  (!record && Boolean(tools.error))
                }
                onCheckedChange={(enabled) =>
                  void setEnabled(record, tool, enabled)
                }
              />
            </li>
          )
        })}
      </ul>
      <InfiniteScroll
        key={`${connectionId}:${filter}:${search}:${visibleRows.length}`}
        canLoadMore={loaded && visibleRows.length < rows.length}
        isLoadingMore={false}
        isFetching={actions.isRefreshing || tools.isRefreshing}
        loadMoreError={null}
        loadMore={() =>
          setVisibleCount((count) =>
            Math.min(count + TOOL_BATCH_SIZE, rows.length)
          )
        }
        itemLabel="tools"
      />
      {loaded && rows.length > TOOL_BATCH_SIZE && (
        <p role="status" className="text-xs text-foreground-muted">
          Showing {visibleRows.length} of {rows.length} tools
        </p>
      )}
    </section>
  )
}
