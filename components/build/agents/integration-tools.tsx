"use client"

import * as React from "react"
import { buildApi, asList } from "@/components/build/operations/build-api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"
import { Switch } from "@/components/ui/switch"
import { useRemote } from "@/components/tracer/hooks"
import type { ActionRecord } from "@/src/lib/build/contracts"
import type { IntegrationTool } from "@/src/lib/build/integrations"

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
  const records = (actions.data ?? []).filter(
    (item) =>
      item.definition.type === "integration" &&
      item.definition.connectionId === connectionId
  )
  const rows = [
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
  ].filter(({ record, tool }) =>
    `${record?.definition.name ?? tool?.name ?? ""} ${record?.definition.description ?? tool?.description ?? ""}`
      .toLowerCase()
      .includes(search.trim().toLowerCase())
  )

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
    <section
      aria-label={`Tools for ${connectionLabel}`}
      className="space-y-3 border-t border-border pt-4"
    >
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Tools for this agent</h3>
        <p className="text-xs text-foreground-muted">
          Choose which tools this agent can use. Changes are saved with the
          agent.
        </p>
      </div>
      <Input
        aria-label={`Search tools for ${connectionLabel}`}
        placeholder="Search tools…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
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
        <p role="status" className="text-sm text-foreground-muted">
          Loading tools…
        </p>
      )}
      {!actions.isLoading && !actions.error && rows.length === 0 && (
        <p className="text-sm text-foreground-muted">
          {search ? "No matching tools." : "No tools available."}
        </p>
      )}
      <div className="max-h-80 space-y-1 overflow-y-auto">
        {rows.map(({ key, record, tool }) => {
          const name = record?.definition.name ?? tool?.name ?? "Tool"
          const description =
            record?.definition.description ?? tool?.description
          return (
            <div
              key={key}
              className="flex items-start gap-3 rounded-md bg-surface-row p-3"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-sm font-medium break-words">{name}</p>
                {description && (
                  <p className="line-clamp-2 text-xs text-foreground-muted">
                    {description}
                  </p>
                )}
              </div>
              {record && onEdit && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onEdit(record)}
                >
                  Settings
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
            </div>
          )
        })}
      </div>
    </section>
  )
}
