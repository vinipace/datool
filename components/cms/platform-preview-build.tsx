"use client"

import { useState } from "react"
import { AgentAvatar } from "@/components/ui/agent-avatar"
import { Chat } from "@/components/ui/chat"
import { ConversationAvatar } from "@/components/ui/inbox-conversation"
import { ChannelIcon } from "@/components/build/shared/channel-identity"
import { ConversationStatusBadge } from "@/components/build/shared/conversation-status"
import { CollectionPanel } from "@/components/tracer/collection-panel"
import { CollectionSearch } from "@/components/tracer/collection-page"
import { HeaderSlot } from "@/components/tracer/collection-header"
import {
  CollectionRow,
  CollectionTable,
  CollectionTableBody,
} from "@/components/tracer/collection-table"
import { collectionTable } from "@/components/tracer/collection-table-styles"
import { TableViewControls } from "@/components/tracer/table-view-controls"
import {
  defaultTableSettings,
  type CollectionTableSettings,
} from "@/src/lib/tracer/custom-views"
import { platformPreviewConversations } from "./platform-preview-fixtures"
import styles from "./platform-preview.module.css"

const conversations = platformPreviewConversations

/** The Build area's real conversations table and inbox chat, using example data. */
export function BuildPreview() {
  const [selectedId, setSelectedId] = useState(conversations[0].id)
  const [query, setQuery] = useState("")
  const [text, setText] = useState("")
  const [settings, setSettings] =
    useState<CollectionTableSettings>(defaultTableSettings)
  const selected =
    conversations.find(({ id }) => id === selectedId) ?? conversations[0]
  const filtered = conversations.filter((item) =>
    [item.subject, item.customer, item.agent]
      .join(" ")
      .toLowerCase()
      .includes(query.toLowerCase())
  )

  return (
    <div className={styles.panels} data-area="build">
      <div className={styles.traceList}>
        <CollectionPanel label="Example conversations" displayIconOnly>
          <TableViewControls>
            <HeaderSlot name="filter">
              <CollectionSearch
                label="Search example conversations"
                value={query}
                onChange={setQuery}
              />
            </HeaderSlot>
            <CollectionTable
              selectionColumnWidth={0}
              enableCardView={false}
              reorderable={false}
              settings={settings}
              onSettingsChange={setSettings}
              widths={[280, 150, 150, 136, 120]}
              columnIds={["subject", "customer", "agent", "channel", "status"]}
            >
              <thead className={collectionTable.head}>
                <tr>
                  <th aria-hidden className="p-0" />
                  {[
                    "Conversation",
                    "Customer",
                    "Agent",
                    "Channel",
                    "Status",
                  ].map((label) => (
                    <th key={label} className={collectionTable.heading}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <CollectionTableBody rows={filtered}>
                {(item) => (
                  <CollectionRow
                    key={item.id}
                    active={item.id === selected.id}
                    rowLabel={item.subject}
                    tabIndex={0}
                    aria-label={`Open example: ${item.subject}`}
                    onClick={() => setSelectedId(item.id)}
                    onKeyDown={(event) => {
                      if (
                        event.target === event.currentTarget &&
                        (event.key === "Enter" || event.key === " ")
                      ) {
                        event.preventDefault()
                        setSelectedId(item.id)
                      }
                    }}
                  >
                    <td aria-hidden className="p-0" />
                    <td className={collectionTable.cell}>
                      <span className="flex min-w-0 items-center gap-2 font-medium">
                        <ConversationAvatar compact name={item.customer} />
                        <span className="truncate">{item.subject}</span>
                      </span>
                    </td>
                    <td className={collectionTable.cell}>{item.customer}</td>
                    <td className={collectionTable.cell}>
                      <span className="flex min-w-0 items-center gap-2">
                        <AgentAvatar
                          appearance={{ avatarColor: "green" }}
                          className="size-5"
                        />
                        <span className="truncate">{item.agent}</span>
                      </span>
                    </td>
                    <td className={collectionTable.cell}>
                      <span className="inline-flex items-center gap-2">
                        <ChannelIcon channel={item.channel} size="sm" />
                        {item.channel === "web" ? "Website" : "WhatsApp"}
                      </span>
                    </td>
                    <td className={collectionTable.cell}>
                      <ConversationStatusBadge status={item.status} />
                    </td>
                  </CollectionRow>
                )}
              </CollectionTableBody>
            </CollectionTable>
          </TableViewControls>
        </CollectionPanel>
      </div>
      <section className={styles.inspector} aria-label="Example conversation">
        <div className={styles.inspectorHeader}>
          <ConversationAvatar compact name={selected.customer} />
          <strong>{selected.customer}</strong>
          <span className={styles.inspectorMetadata}>
            <ChannelIcon channel={selected.channel} size="sm" />
            {selected.updated}
          </span>
          <ConversationStatusBadge status={selected.status} />
        </div>
        <div className={styles.conversation}>
          <Chat
            key={selected.id}
            variant="inbox"
            perspective="operator"
            messages={selected.messages}
            text={text}
            onTextChange={setText}
            running={false}
            canSubmit={false}
            composerDisabled
            placeholder="Take over the conversation before replying…"
          />
        </div>
      </section>
    </div>
  )
}
