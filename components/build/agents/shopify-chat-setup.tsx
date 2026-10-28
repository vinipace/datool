"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/select"
import { Notice } from "@/components/ui/notice"
import { useRemote } from "@/components/tracer/hooks"
import { buildApi } from "@/components/build/operations/build-api"
import type { ChannelConnection } from "@/src/lib/build/channels"

export function ShopifyChatSetup({ connectionId }: { connectionId: string }) {
  const channels = useRemote(
    (signal) =>
      buildApi.call<ChannelConnection[]>("build_list_channels", {}, signal),
    []
  )
  const [selected, setSelected] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [editor, setEditor] = React.useState<string | null>(null)
  const options = (channels.data ?? []).filter(
    (channel) => channel.channel === "web" && channel.status === "connected"
  )
  const fieldId = React.useId()
  async function connect() {
    if (!selected || pending) return
    setPending(true)
    setError(null)
    setEditor(null)
    try {
      const result = await buildApi.call<{ themeEditorUrl: string }>(
        "build_configure_shopify_chat",
        { connectionId, channelId: selected }
      )
      setEditor(result.themeEditorUrl)
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not connect the store chat."
      )
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="space-y-3">
      <label htmlFor={fieldId} className="text-sm font-medium">
        Storefront chat
      </label>
      {channels.isLoading ? (
        <p role="status" className="text-sm text-foreground-muted">
          Loading chat bubbles…
        </p>
      ) : channels.error ? (
        <Notice variant="error">
          Could not load chat bubbles.{" "}
          <Button size="sm" variant="outline" onClick={channels.refresh}>
            Retry
          </Button>
        </Notice>
      ) : options.length === 0 ? (
        <p className="text-sm text-foreground-muted">
          Enable a chat bubble in Channels first, then connect it here.
        </p>
      ) : (
        <>
          <Select
            id={fieldId}
            value={selected}
            disabled={pending}
            onChange={(event) => {
              setSelected(event.target.value)
              setEditor(null)
            }}
          >
            <option value="">Choose a chat bubble</option>
            {options.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.label}
              </option>
            ))}
          </Select>
          <p className="text-xs text-foreground-muted">
            Returning shoppers keep their chat. Logged-in customers are verified
            by Shopify. This replaces the chat bubble currently connected to
            this store.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={!selected || pending}
            loading={pending}
            onClick={() => void connect()}
          >
            Connect chat bubble
          </Button>
        </>
      )}
      {error && (
        <Notice role="alert" variant="error">
          {error}
        </Notice>
      )}
      {editor && (
        <Notice>
          Connected. Enable “Datool chat” in App embeds and save your theme.{" "}
          <Button size="sm" variant="outline" asChild>
            <a href={editor} target="_blank" rel="noopener noreferrer">
              Open theme editor
            </a>
          </Button>
        </Notice>
      )}
    </div>
  )
}
