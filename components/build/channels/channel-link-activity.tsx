"use client"

import Link from "next/link"
import { RefreshCw } from "lucide-react"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import { Skeleton } from "@/components/ui/skeleton"
import { collectionTable } from "@/components/tracer/collection-table-styles"
import { useWorkspaceHref } from "@/components/tracer/workspace-path"
import { useRemote } from "@/components/tracer/hooks"
import { buildApi } from "@/components/build/operations/build-api"
import type { ChannelLinks } from "@/src/lib/build/channel-links"

export function ChannelLinkActivity({
  connectionId,
  agentId,
}: {
  connectionId: string
  agentId: string
}) {
  const info = useRemote(
    (signal) =>
      buildApi.call<ChannelLinks>(
        "build_list_channel_links",
        { connectionId },
        signal
      ),
    [connectionId]
  )
  return (
    <ChannelLinkActivityContent
      data={info.data}
      loading={info.isLoading}
      error={Boolean(info.error)}
      onRefresh={info.refresh}
      agentId={agentId}
    />
  )
}

export function ChannelLinkActivityContent({
  data,
  loading,
  error,
  onRefresh,
  agentId,
}: {
  data?: ChannelLinks | null
  loading: boolean
  error: boolean
  onRefresh: () => void
  agentId: string
}) {
  const href = useWorkspaceHref()
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-4">
        <div className="space-y-1">
          <CardTitle>Link activity</CardTitle>
          <CardDescription>
            Latest 20 links sent in this channel. Short links work for 90 days.
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh link activity"
        >
          <RefreshCw aria-hidden="true" />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <Notice variant="error" role="alert">
            Could not load link activity. Try refreshing.
          </Notice>
        ) : loading && !data ? (
          <div
            role="status"
            aria-label="Loading link activity"
            className="space-y-2"
          >
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : !data?.items.length ? (
          <p className="text-sm text-foreground-muted">
            Links in new WhatsApp replies will appear here after they are sent.
          </p>
        ) : (
          <div className="max-h-96 overflow-auto">
            <table className={collectionTable.table}>
              <caption className="sr-only">
                Sent links and estimated visits
              </caption>
              <thead className={collectionTable.head}>
                <tr>
                  <th
                    scope="col"
                    className={`${collectionTable.heading} w-3/5`}
                  >
                    Link / conversation
                  </th>
                  <th scope="col" className={collectionTable.heading}>
                    Clicks
                  </th>
                  <th scope="col" className={collectionTable.heading}>
                    Auto
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.token} className={collectionTable.row}>
                    <td className={`${collectionTable.cell} py-2`}>
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto max-w-full justify-start p-0"
                        asChild
                      >
                        <a
                          href={item.destination}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={item.destination}
                        >
                          <span className="truncate">
                            {item.label && item.label !== item.destination
                              ? item.label
                              : new URL(item.destination).hostname +
                                new URL(item.destination).pathname}
                          </span>
                        </a>
                      </Button>
                      <div>
                        <Button
                          variant="ghost-muted"
                          size="sm"
                          className="h-auto max-w-full justify-start p-0 text-xs"
                          asChild
                        >
                          <Link
                            href={href(
                              `/build/agents/${agentId}?section=conversations&conversation=${item.conversationId}`
                            )}
                          >
                            View conversation
                          </Link>
                        </Button>
                      </div>
                      <p className="text-xs text-foreground-muted">
                        {item.lastClickedAt
                          ? `Last click: ${new Date(item.lastClickedAt).toLocaleString()}`
                          : "No clicks yet"}
                      </p>
                    </td>
                    <td className={`${collectionTable.cell} tabular-nums`}>
                      {item.clicks}
                    </td>
                    <td className={`${collectionTable.cell} tabular-nums`}>
                      {item.automatedVisits}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs leading-5 text-foreground-muted">
          Clicks are estimated visits, including repeat opens. Known previews
          and bots are counted separately as Auto; unknown automation may still
          count as clicks. These metrics do not store visitor identities or IP
          addresses.
        </p>
      </CardContent>
    </Card>
  )
}
