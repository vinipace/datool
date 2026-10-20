"use client"

import Link from "next/link"
import { CollectionPanel } from "@/components/tracer/collection-panel"
import { CollectionPage } from "@/components/tracer/collection-page"
import {
  CollectionRow,
  CollectionTable,
  CollectionTableBody,
} from "@/components/tracer/collection-table"
import { collectionTable } from "@/components/tracer/collection-table-styles"
import { useCollectionPages } from "@/components/tracer/use-collection-pages"
import { useWorkspaceHref } from "@/components/tracer/workspace-path"
import { formatDate } from "@/components/tracer/format"
import type { CollectionListOptions } from "@/components/tracer/api"
import type { ApiList, JsonValue } from "@/src/lib/tracer/contracts"
import { StructuredValueView } from "@/components/ui/structured-value-view"
import { Button } from "@/components/ui/button"
import { buildApi } from "../operations/build-api"
import { BuildEmpty, BuildStatus } from "../operations/build-page"

type ActivityRecord = {
  id: string
  contactId: string | null
  conversationId: string | null
  source: string | null
  createdAt: string | null
  status?: string
  score?: number | null
  data?: JsonValue
  fieldKey?: string
  value?: JsonValue
}

function listActivity({
  filter,
  cursor,
  limit,
  signal,
}: CollectionListOptions) {
  const { agentId, section } = JSON.parse(filter ?? "{}") as {
    agentId: string
    section: "leads" | "collected-data"
  }
  return buildApi.call<ApiList<ActivityRecord>>(
    section === "leads" ? "build_list_leads" : "build_list_collected_data",
    { agentId, cursor, limit },
    signal
  )
}

export function AgentActivity({
  agentId,
  section,
}: {
  agentId: string
  section: "leads" | "collected-data"
}) {
  const href = useWorkspaceHref()
  const state = useCollectionPages(
    listActivity,
    JSON.stringify({ agentId, section }),
    15_000
  )
  const isLeads = section === "leads"
  const label = isLeads ? "Leads" : "Collected data"
  const columns = isLeads
    ? ["Data", "Status", "Score", "Conversation", "Source", "Created"]
    : ["Field", "Value", "Conversation", "Source", "Collected"]
  return (
    <CollectionPanel label={label}>
      <CollectionPage
        className="contents"
        state={state}
        loadingLabel={`Loading ${label.toLowerCase()}`}
        pagination={state}
        header={{
          children: <h2 className="text-sm font-medium">{label}</h2>,
          exportRows: state.items,
          exportName: `agent-${section}`,
        }}
        isEmpty={!state.items.length}
        empty={
          <BuildEmpty
            title={isLeads ? "No leads yet" : "No collected data yet"}
            description={
              isLeads
                ? "Leads captured in this agent’s conversations will appear here."
                : "Customer fields collected in this agent’s conversations will appear here."
            }
          />
        }
      >
        <CollectionTable
          columnIds={columns.map((column) => column.toLowerCase())}
          widths={
            isLeads ? [300, 130, 80, 200, 150, 180] : [200, 300, 200, 150, 180]
          }
          persistenceKey={`build-agent-${section}`}
        >
          <thead className={collectionTable.head}>
            <tr>
              <th aria-hidden className={collectionTable.heading} />
              {columns.map((column) => (
                <th key={column} className={collectionTable.heading}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <CollectionTableBody rows={state.items}>
            {(item, index) => (
              <CollectionRow key={item.id}>
                <td className={collectionTable.cell}>
                  <span className="text-xs text-foreground-muted">
                    {index + 1}
                  </span>
                </td>
                <td className={collectionTable.cell}>
                  {isLeads ? (
                    <StructuredValueView
                      value={item.data ?? null}
                      view="json"
                      compact
                    />
                  ) : (
                    item.fieldKey
                  )}
                </td>
                <td className={collectionTable.cell}>
                  {isLeads ? (
                    <BuildStatus status={item.status ?? "new"} />
                  ) : (
                    <StructuredValueView
                      value={item.value ?? null}
                      view="json"
                      compact
                    />
                  )}
                </td>
                {isLeads ? (
                  <td className={collectionTable.cell}>{item.score ?? "—"}</td>
                ) : null}
                <td className={collectionTable.cell}>
                  {item.conversationId ? (
                    <Button variant="link" size="sm" asChild>
                      <Link
                        href={href(
                          `/build/conversations?q=${encodeURIComponent(item.conversationId)}&conversation=${encodeURIComponent(item.conversationId)}`
                        )}
                      >
                        Open conversation
                      </Link>
                    </Button>
                  ) : (
                    <span className="text-foreground-muted">—</span>
                  )}
                </td>
                <td className={collectionTable.cell}>{item.source || "—"}</td>
                <td className={collectionTable.cell}>
                  {item.createdAt ? formatDate(item.createdAt) : "—"}
                </td>
              </CollectionRow>
            )}
          </CollectionTableBody>
        </CollectionTable>
      </CollectionPage>
    </CollectionPanel>
  )
}
