"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { ArrowUpRight, Plus, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Select } from "@/components/ui/select"
import { useRemote } from "@/components/tracer/hooks"
import { useWorkspaceHref } from "@/components/tracer/workspace-path"
import { ChannelIcon } from "@/components/build/shared/channel-identity"
import type { ChannelConnection } from "@/src/lib/build/channels"
import {
  channelCatalog,
  channelLabel,
  connectionPresentation,
  type ChannelPresentationId,
} from "@/components/build/shared/channel-catalog"
import { buildApi, asList } from "./build-api"
import { BuildEmpty, BuildFrame, BuildState, BuildStatus } from "./build-page"

type Agent = { id: string; name: string }
const availableChannels = (
  Object.keys(channelCatalog) as ChannelPresentationId[]
).filter((id) => channelCatalog[id].available)

export function IntegrationsPage() {
  return <ChannelsManager />
}

export function ChannelsManager({
  fixedAgentId,
  embedded = false,
}: {
  fixedAgentId?: string
  embedded?: boolean
}) {
  const workspaceHref = useWorkspaceHref()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [selectedAgent, setSelectedAgent] = React.useState<string | null>(
    searchParams.get("agentId")
  )
  const agents = useRemote(
    (signal) =>
      buildApi
        .call<unknown>("build_list_agents", { includeArchived: false }, signal)
        .then(asList<Agent>),
    [],
    { enabled: !fixedAgentId }
  )
  const agentId =
    fixedAgentId ||
    (selectedAgent === null ? agents.data?.[0]?.id || "" : selectedAgent)
  const connections = useRemote(
    (signal) =>
      buildApi
        .call<unknown>("build_list_channels", { agentId }, signal)
        .then(asList<ChannelConnection>),
    [agentId],
    { enabled: Boolean(agentId), intervalMs: 15_000 }
  )
  function editorHref(connectionId: string, channel?: ChannelPresentationId) {
    const query = new URLSearchParams({ agentId })
    if (embedded) query.set("from", "agent")
    if (channel) query.set("channel", channel)
    return workspaceHref(`/build/integrations/${connectionId}?${query}`)
  }
  const content = (
    <BuildState
      isLoading={agents.isLoading || connections.isLoading}
      error={agents.error ?? connections.error}
      onRetry={() => {
        agents.refresh()
        connections.refresh()
      }}
    >
      {!agentId ? (
        <BuildEmpty
          title="Select an agent"
          description="Choose the agent you want customers to reach."
        />
      ) : (
        <div className="space-y-8">
          <div className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {availableChannels.map((channel) => (
              <Card key={channel} className="flex min-w-0 flex-col">
                <CardHeader className="gap-4">
                  <ChannelIcon channel={channel} className="size-12" />
                  <div className="space-y-2">
                    <CardTitle>{channelLabel(channel)}</CardTitle>
                    <CardDescription>
                      {channelCatalog[channel].description}
                    </CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="mt-auto flex justify-end pt-5">
                  <Button variant="outline" size="sm" asChild>
                    <Link href={editorHref("new", channel)}>
                      <Plus className="size-3.5" />
                      Set up {channelLabel(channel)}
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
          <section aria-label="Your connections" className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium">
                Your connections{" "}
                <span className="ml-1 text-foreground-muted">
                  {connections.data?.length ?? 0}
                </span>
              </h2>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Refresh channels"
                loading={connections.isRefreshing}
                onClick={connections.refresh}
              >
                <RefreshCw className="size-4" />
              </Button>
            </div>
            {connections.data?.length ? (
              <div className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {connections.data.map((connection) => (
                  <Card key={connection.id} className="flex min-w-0 flex-col">
                    <CardHeader className="gap-4">
                      <div className="flex items-center justify-between gap-3">
                        <ChannelIcon
                          channel={connectionPresentation(connection)}
                        />
                        <BuildStatus status={connection.status} />
                      </div>
                      <div className="min-w-0 space-y-1">
                        <CardTitle className="truncate">
                          {connection.label}
                        </CardTitle>
                        <CardDescription>
                          {channelLabel(connectionPresentation(connection))}
                        </CardDescription>
                      </div>
                    </CardHeader>
                    <CardContent className="mt-auto space-y-4 pt-4">
                      {connection.lastError ? (
                        <p className="text-xs text-destructive">
                          {connection.lastError}
                        </p>
                      ) : (
                        <p className="text-xs text-foreground-muted">
                          {connection.lastInboundAt
                            ? `Last message ${new Date(connection.lastInboundAt).toLocaleString()}`
                            : "No messages yet"}
                        </p>
                      )}
                      <div className="flex justify-end">
                        <Button size="sm" variant="outline" asChild>
                          <Link
                            aria-label={`Manage ${connection.label}`}
                            href={editorHref(connection.id)}
                          >
                            Manage
                            <ArrowUpRight className="size-3.5" />
                          </Link>
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <BuildEmpty
                title="No channels connected"
                description="Choose a channel above to set up your first connection."
              />
            )}
          </section>
        </div>
      )}
    </BuildState>
  )
  if (embedded)
    return <div className="w-full min-w-0 px-4 py-6 sm:px-6">{content}</div>
  return (
    <BuildFrame
      title="Channels"
      description="Choose where customers can talk to your agent."
      actions={
        <div className="flex min-w-0 items-center gap-2">
          <Select
            aria-label="Channel agent"
            value={agentId}
            onChange={(event) => setSelectedAgent(event.target.value)}
            className="h-8 w-auto max-w-48 text-xs"
          >
            <option value="">Select agent…</option>
            {agents.data?.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            disabled={!agentId}
            onClick={() => router.push(editorHref("new", "web"))}
          >
            <Plus className="size-3.5" />
            Connect channel
          </Button>
        </div>
      }
    >
      {content}
    </BuildFrame>
  )
}
