"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Bot, Copy, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AgentAvatar } from "@/components/ui/agent-avatar"
import { Notice } from "@/components/ui/notice"
import { Select } from "@/components/ui/select"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { PanelActionLabel } from "@/components/ui/panel-action-label"
import { CollectionPanel } from "@/components/tracer/collection-panel"
import {
  CollectionPage,
  CollectionSearch,
} from "@/components/tracer/collection-page"
import { CollectionRow, CollectionTable, CollectionTableBody } from "@/components/tracer/collection-table"
import { collectionTable } from "@/components/tracer/collection-table-styles"
import { useRemote } from "@/components/tracer/hooks"
import {
  useWorkspaceHref,
  useWorkspaceStorageScope,
} from "@/components/tracer/workspace-path"
import { useTableView } from "@/components/tracer/use-table-view"
import { BuildStatus } from "@/components/build/shared/build-layout"
import { ChannelIcon } from "@/components/build/shared/channel-identity"
import {
  channelLabel,
  connectionPresentation,
  type ChannelPresentationId,
} from "@/components/build/shared/channel-catalog"
import {
  buildCall,
  buildOperations,
  formatBuildError,
  listItems,
} from "@/components/build/shared/build-api"
import type { ManagedAgent } from "@/src/lib/build/contracts"
import type { ChannelConnection } from "@/src/lib/build/channels"

export function BuildLandingPage() {
  return <BuildAgentsPage />
}

export function BuildAgentsPage() {
  const workspaceHref = useWorkspaceHref()
  const router = useRouter()
  const scope = useWorkspaceStorageScope()
  const tableView = useTableView({
    resource: "agents",
    settingsStorageKey: `datool:build-agents:${scope}:settings`,
    orderStorageKey: "datool.build-agents.columns",
  })
  const load = React.useCallback(
    async (signal: AbortSignal) => {
      const [agents, channels] = await Promise.all([
        buildCall<unknown>(
          buildOperations.listAgents,
          { includeArchived: true },
          { signal }
        ).then((value) => listItems<ManagedAgent>(value)),
        buildCall<unknown>(buildOperations.listChannels, {}, { signal }).then(
          (value) => listItems<ChannelConnection>(value)
        ),
      ])
      const channelsByAgent = new Map<string, ChannelConnection[]>()
      for (const connection of channels) {
        const connections = channelsByAgent.get(connection.agentId) ?? []
        connections.push(connection)
        channelsByAgent.set(connection.agentId, connections)
      }
      return agents.map((agent) => ({
        ...agent,
        channels: channelsByAgent.get(agent.id) ?? [],
      }))
    },
    []
  )
  const state = useRemote(load, [], { intervalMs: 10_000 })
  const [search, setSearch] = React.useState("")
  const [status, setStatus] = React.useState("current")
  const [cloneError, setCloneError] = React.useState<string | null>(null)
  const [cloning, setCloning] = React.useState<string | null>(null)
  const rows = React.useMemo(() => {
    const query = search.trim().toLowerCase()
    return (state.data ?? []).filter(
      (agent) =>
        (status === "all" || (status === "archived" ? agent.status === "archived" : agent.status !== "archived")) &&
        (!query ||
        `${agent.name} ${agent.slug} ${agent.description ?? ""}`
          .toLowerCase()
          .includes(query))
    )
  }, [search, status, state.data])

  async function cloneAgent(agent: ManagedAgent) {
    if (cloning) return
    setCloneError(null)
    setCloning(agent.id)
    try {
      const created = await buildCall<ManagedAgent>(
        buildOperations.cloneAgent,
        {
          sourceAgentId: agent.id,
          name: `${agent.name} copy`,
        }
      )
      router.push(
        workspaceHref(`/build/agents/${encodeURIComponent(created.id)}`)
      )
    } catch (error) {
      setCloneError(formatBuildError(error))
    } finally {
      setCloning(null)
    }
  }

  return (
    <CollectionPanel label="Build agents">
      <CollectionPage
        className="contents"
        state={state}
        loadingLabel="Loading Build agents"
        toolbar={
          cloneError ? (
            <Notice role="alert" variant="error" className="mb-2">
              {cloneError}
            </Notice>
          ) : tableView.storageError ? (
            <Notice variant="error" role="status" className="mb-2">
              {tableView.storageError}
            </Notice>
          ) : null
        }
        header={{
          exportRows: rows,
          exportName: "build-agents",
          children: (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <CollectionSearch
                label="Search agents"
                value={search}
                onChange={setSearch}
              />
              <Select aria-label="Agent status" value={status} onChange={(event) => setStatus(event.target.value)} className="h-8 w-auto max-w-32 text-xs">
                <option value="current">Current agents</option>
                <option value="archived">Archived</option>
                <option value="all">All agents</option>
              </Select>
            </div>
          ),
          actions: (
            <Button size="sm" asChild>
              <Link href={workspaceHref("/build/agents/new")}>
                <Plus className="size-4" />
                <PanelActionLabel>New agent</PanelActionLabel>
              </Link>
            </Button>
          ),
        }}
      >
        <CollectionTable
          fillHeight
          enableCardView
          settings={tableView.settings}
          onSettingsChange={tableView.onSettingsChange}
          columnOrderStore={tableView.columnOrderStore}
          widths={[320, 200, 120, 220, 200, 72]}
          columnIds={[
            "name",
            "channels",
            "status",
            "publication",
            "updated",
            "actions",
          ]}
          actionColumnIds={["actions"]}
          reorderable
        >
          <thead className={collectionTable.head}>
            <tr>
              <th aria-hidden className={collectionTable.heading} />
              {[
                "Name",
                "Channels",
                "Status",
                "Published version",
                "Updated",
                "Actions",
              ].map((label) => (
                <th key={label} className={collectionTable.heading}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <CollectionTableBody
            rows={rows}
            empty={
              <tr>
                <td colSpan={7} className="py-20 text-center">
                  <Bot className="mx-auto mb-3 size-6 text-foreground-muted" />
                  <p className="font-medium">
                    {search ? "No matching agents" : status === "archived" ? "No archived agents" : "Build your first agent"}
                  </p>
                  <p className="mt-1 text-sm text-foreground-muted">
                    {search ? "Try another name or clear your search." : status === "archived" ? "Agents you archive will appear here." : "Start with a name and instructions. Then add knowledge and connect a channel."}
                  </p>
                  {search ? <Button className="mt-4" size="sm" variant="outline" onClick={() => setSearch("")}>Clear search</Button> : status !== "archived" ? <Button className="mt-4" size="sm" variant="outline" asChild>
                    <Link href={workspaceHref("/build/agents/new")}>
                      <Plus className="size-4" />
                      New agent
                    </Link>
                  </Button> : null}
                </td>
              </tr>
            }
          >
            {(agent) => (
              <CollectionRow
                key={agent.id}
                rowLabel={`Open ${agent.name}`}
                onClick={() =>
                  router.push(
                    workspaceHref(
                      `/build/agents/${encodeURIComponent(agent.id)}`
                    )
                  )
                }
              >
                <td aria-hidden className={collectionTable.cell} />
                <td className={collectionTable.cell}>
                  <Link
                    className="inline-flex max-w-full items-center gap-2 font-medium hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    href={workspaceHref(
                      `/build/agents/${encodeURIComponent(agent.id)}`
                    )}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <AgentAvatar appearance={agent.configuration.appearance} />
                    <span className="truncate">{agent.name}</span>
                  </Link>
                  {agent.description ? (
                    <p className="mt-1 max-w-xs truncate text-xs text-foreground-muted">
                      {agent.description}
                    </p>
                  ) : null}
                </td>
                <td className={collectionTable.cell}>
                  <AgentChannels agentId={agent.id} channels={agent.channels} />
                </td>
                <td className={collectionTable.cell}>
                  <BuildStatus state={agent.status} label={agent.status === "active" ? "Active" : agent.status === "archived" ? "Archived" : "Draft"} />
                </td>
                <td className={collectionTable.cell}>
                  <span className="text-xs">{agent.appliedRevision ? `Version ${agent.appliedRevision}` : "Not published"}</span>
                  {agent.currentRevision > agent.appliedRevision ? <span className="ml-2 text-xs text-warning">Draft changes</span> : null}
                </td>
                <td
                  className={`${collectionTable.cell} text-xs text-foreground-muted`}
                >
                  {formatDate(agent.updatedAt)}
                </td>
                <td className={collectionTable.cell}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Clone ${agent.name}`}
                    title="Clone agent"
                    loading={cloning === agent.id}
                    onClick={(event) => {
                      event.stopPropagation()
                      void cloneAgent(agent)
                    }}
                  >
                    {cloning !== agent.id ? (
                      <Copy className="size-3.5" />
                    ) : null}
                  </Button>
                </td>
              </CollectionRow>
            )}
          </CollectionTableBody>
        </CollectionTable>
      </CollectionPage>
    </CollectionPanel>
  )
}

function AgentChannels({
  agentId,
  channels,
}: {
  agentId: string
  channels: ChannelConnection[]
}) {
  const workspaceHref = useWorkspaceHref()
  const groups = new Map<ChannelPresentationId, ChannelConnection[]>()
  for (const connection of channels) {
    const presentation = connectionPresentation(connection)
    const connections = groups.get(presentation) ?? []
    connections.push(connection)
    groups.set(presentation, connections)
  }
  if (!groups.size)
    return <span className="text-xs text-foreground-muted">No channels</span>

  const channelsHref = workspaceHref(
    `/build/agents/${encodeURIComponent(agentId)}?section=channels`
  )
  return (
    <div className="flex items-center gap-1">
      {[...groups].slice(0, 4).map(([channel, connections]) => (
        <Tooltip key={channel}>
          <TooltipTrigger asChild>
            <Button asChild variant="ghost" size="icon-sm">
              <Link
                href={
                  connections.length === 1
                    ? workspaceHref(
                        `/build/integrations/${encodeURIComponent(connections[0].id)}?${new URLSearchParams({ agentId, from: "agent" })}`
                      )
                    : channelsHref
                }
                aria-label={`${channelLabel(channel)}: ${connections.map((connection) => `${connection.label} (${connection.status})`).join(", ")}`}
                onClick={(event) => event.stopPropagation()}
              >
                <ChannelIcon channel={channel} size="sm" />
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p className="font-medium">{channelLabel(channel)}</p>
            {connections.map((connection) => (
              <p key={connection.id}>
                {connection.label} · {connection.status}
              </p>
            ))}
          </TooltipContent>
        </Tooltip>
      ))}
      {groups.size > 4 ? (
        <Button asChild variant="ghost" size="icon-sm">
          <Link
            href={channelsHref}
            aria-label={`View all ${groups.size} channel types`}
            onClick={(event) => event.stopPropagation()}
          >
            +{groups.size - 4}
          </Link>
        </Button>
      ) : null}
    </div>
  )
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date)
}
