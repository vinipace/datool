"use client"

import * as React from "react"
import { useRemote } from "@/components/tracer/hooks"
import { ChatBubbleEditor } from "../channels/chat-bubble-editor"
import { asList, buildApi } from "../operations/build-api"
import { BuildState } from "../operations/build-page"
import type { ChannelConnection } from "@/src/lib/build/channels"
import type { ManagedAgent } from "@/src/lib/build/contracts"

export function AgentPlayground({ agent }: { agent: ManagedAgent }) {
  const [creationKey] = React.useState(() => crypto.randomUUID())
  const state = useRemote(
    async (signal) => {
      const channels = asList<ChannelConnection>(
        await buildApi.call(
          "build_list_channels",
          { agentId: agent.id },
          signal
        )
      ).filter(
        (connection) =>
          connection.channel === "web" &&
          (connection.config.bubble as { layout?: string } | undefined)
            ?.layout !== "help_page"
      )
      const existing =
        channels.find((connection) => connection.status === "connected") ??
        channels[0]
      if (existing) return existing
      return buildApi.call<ChannelConnection>(
        "build_create_channel",
        { agentId: agent.id, channel: "web", label: "Chat Bubble", config: {} },
        { signal, idempotencyKey: creationKey }
      )
    },
    [agent.id, creationKey]
  )

  return (
    <BuildState
      isLoading={state.isLoading}
      error={state.error}
      onRetry={state.refresh}
    >
      {state.data ? (
        <ChatBubbleEditor
          key={state.data.id}
          connection={state.data}
          agent={agent}
          embedded
        />
      ) : null}
    </BuildState>
  )
}
