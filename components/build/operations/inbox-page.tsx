"use client"

import * as React from "react"
import Link from "next/link"
import {
  Bot,
  MoreHorizontal,
  MessageSquare,
  StickyNote,
  Info,
  ListFilter,
  Check,
  LoaderCircle,
  LockKeyhole,
  Settings2,
  RefreshCw,
  X,
  Play,
  Send,
  UserRound,
} from "lucide-react"

import {
  ConversationAvatar,
  ConversationRow,
  InboxQueueChip,
  ConversationListSkeleton,
} from "@/components/ui/inbox-conversation"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import { ChatFeedback } from "@/components/ui/chat-feedback"
import { Chat } from "@/components/ui/chat"
import { AgentAvatar } from "@/components/ui/agent-avatar"
import { productIcons } from "@/components/product-icons"
import { PriorityIndicator } from "@/components/ui/priority-indicator"
import { UserAvatarImage } from "@/components/ui/user-avatar"
import { formatDate, formatRelative } from "@/components/tracer/format"
import type { ChatFeedbackValue } from "@/components/ui/chat-feedback"
import type { InspectorMessage } from "@/src/lib/tracer/value-messages"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CollectionPanel } from "@/components/tracer/collection-panel"
import {
  CollectionPage,
  CollectionSearch,
} from "@/components/tracer/collection-page"
import { CollectionInspectorOverlay } from "@/components/tracer/collection-inspector-overlay"
import {
  CollectionRow,
  CollectionTable,
  CollectionTableBody,
} from "@/components/tracer/collection-table"
import { collectionTable } from "@/components/tracer/collection-table-styles"
import { useCollectionPages } from "@/components/tracer/use-collection-pages"
import type { CollectionListOptions } from "@/components/tracer/api"
import { useTableView } from "@/components/tracer/use-table-view"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { InspectorSection } from "@/components/ui/inspector-section"
import { useMutation, useRemote } from "@/components/tracer/hooks"
import {
  useWorkspaceHref,
  useWorkspaceStorageScope,
} from "@/components/tracer/workspace-path"
import { buildApi, asList, asRecord } from "./build-api"
import {
  BuildEmpty,
  BuildFormCard,
  BuildState,
  BuildStatus,
} from "./build-page"
import { useWideViewport } from "./use-wide-viewport"
import { TicketAssignment } from "./ticket-assignment"
import { ChannelIcon } from "@/components/build/shared/channel-identity"
import {
  TicketStatusIndicator,
  TicketStatusSelect,
} from "@/components/build/shared/ticket-status"
import {
  ConversationStatusBadge,
  ConversationStatusSelect,
} from "@/components/build/shared/conversation-status"
import type { ChannelId } from "@/src/lib/build/channels"
import type { AgentAppearance } from "@/src/lib/build/contracts"
import { InboxConversations } from "@/components/build/shared/inbox-sidebar"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { useInboxNavigation } from "@/components/build/shared/inbox-navigation"
import { NewTicketDialog } from "./new-ticket-dialog"

type Ticket = {
  id: string
  agentName?: string | null
  agentAvatar?: Pick<
    AgentAppearance,
    "avatarUrl" | "avatarStyle" | "avatarColor"
  > | null
  version?: number
  ticketId?: string | null
  conversationStatus?: string
  conversationId?: string | null
  contactId?: string | null
  contactName?: string | null
  subject?: string | null
  channel?: ChannelId | null
  status?: string | null
  priority?: string | null
  assigneeName?: string | null
  assigneeImage?: string | null
  teamName?: string | null
  assigneeUserId?: string | null
  teamId?: string | null
  lastMessageAt?: string | null
  updatedAt?: string | null
  ownerType?: string | null
  ownerId?: string | null
  connectionId?: string | null
  externalConversationId?: string | null
  messages?: Message[]
  notes?: Note[]
  macros?: Macro[]
}
type Message = {
  id?: string
  author?: InspectorMessage["author"]
  role?: string
  direction?: string
  content?: unknown
  metadata?: unknown
  text?: string
  createdAt?: string
  status?: string
  attachments?: InspectorMessage["attachments"]
}
type ApprovalContinuation = {
  actionId: string
  continuationId: string
  message?: string
}
type Note = {
  id?: string
  body: string
  authorId?: string | null
  authorName?: string | null
  authorImage?: string | null
  createdAt?: string
}
type Macro = {
  id: string
  name: string
  body: string
  enabled?: boolean
  actions?: unknown[]
}
type Team = {
  id: string
  name: string
  description?: string
  enabled?: boolean
  memberCount?: number
}
type RoutingRule = {
  id: string
  name: string
  priority?: number
  enabled?: boolean
  conditions?: Record<string, unknown>
  teamId?: string | null
  assigneeUserId?: string | null
}
type Survey = {
  id: string
  ticketId?: string | null
  conversationId?: string | null
  status?: string
  rating?: number | null
  comment?: string | null
  requestedAt?: string
  expiresAt?: string | null
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>
    if (typeof record.text === "string") return record.text
    if (Array.isArray(record.parts))
      return record.parts.map((part) => textOf(part)).join(" ")
  }
  return content == null ? "" : JSON.stringify(content)
}

function ticketList(value: unknown) {
  const record = asRecord(value)
  return {
    items: asList<Ticket>(record.items ?? value),
    nextCursor:
      typeof record.nextCursor === "string" ? record.nextCursor : null,
  }
}

function listTickets({ filter, cursor, limit, signal }: CollectionListOptions) {
  const filters = JSON.parse(filter ?? "{}") as {
    search?: string
    status?: string
    queue?: string
    agentId?: string
  }
  return buildApi
    .call<unknown>(
      "build_list_tickets",
      {
        cursor,
        limit,
        order: "recent",
        search: filters.search || undefined,
        status: filters.status || undefined,
        queue: filters.queue,
        agentId: filters.agentId,
      },
      signal
    )
    .then(ticketList)
}

function listConversations({
  filter,
  cursor,
  limit,
  signal,
}: CollectionListOptions) {
  const filters = JSON.parse(filter ?? "{}") as {
    search?: string
    status?: string
    agentId?: string
  }
  return buildApi
    .call<unknown>(
      "build_list_conversations",
      {
        cursor,
        limit,
        search: filters.search || undefined,
        status: filters.status || undefined,
        agentId: filters.agentId,
      },
      signal
    )
    .then((value) => {
      const page = ticketList(value)
      return {
        ...page,
        items: page.items.map((item) => {
          const summary = item as Ticket & {
            ticketStatus: string | null
            ticketVersion: number | null
          }
          return {
            ...item,
            conversationId: item.id,
            conversationStatus: item.status ?? "active",
            status: summary.ticketStatus,
            version: summary.ticketVersion ?? undefined,
          }
        }),
      }
    })
}

function detailFrom(value: unknown): Ticket | null {
  const record = asRecord(value)
  if (record.ticket && typeof record.ticket === "object")
    return record.ticket as Ticket
  if (record.id) return record as Ticket
  return null
}

function conversationFrom(value: unknown) {
  const record = asRecord(value)
  return (
    record.conversation && typeof record.conversation === "object"
      ? record.conversation
      : record
  ) as Record<string, unknown>
}

function messageList(value: unknown) {
  const record = asRecord(value)
  return asList<Message>(record.items ?? value)
}

function approvalFromMessage(message: Message): ApprovalContinuation | null {
  if (message.role !== "assistant") return null
  for (const source of [message.content, message.metadata]) {
    const continuations = asList<unknown>(asRecord(source).continuations)
    for (const item of continuations) {
      const continuation = asRecord(item)
      const actionId =
        typeof continuation.actionId === "string"
          ? continuation.actionId.trim()
          : ""
      const continuationId =
        typeof continuation.continuationId === "string"
          ? continuation.continuationId.trim()
          : ""
      if (
        continuation.type !== "approval_required" ||
        !actionId ||
        !continuationId
      )
        continue
      return {
        actionId,
        continuationId,
        message:
          typeof continuation.message === "string"
            ? continuation.message
            : undefined,
      }
    }
  }
  return null
}

function messageText(message: Message, approval: ApprovalContinuation | null) {
  if (typeof message.text === "string" && message.text.trim())
    return message.text
  if (approval)
    return (
      approval.message || "This action is waiting for an operator approval."
    )
  return textOf(message.content)
}

function ApprovalActionCard({
  approval,
  approved,
  loading,
  disabled,
  onApprove,
}: {
  approval: ApprovalContinuation
  approved: boolean
  loading: boolean
  disabled: boolean
  onApprove: () => void
}) {
  return (
    <div className="mt-3 rounded-md border border-warning-border bg-warning-background px-3 py-3 text-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="font-medium text-warning-foreground">
            Approval required
          </p>
          <p className="text-foreground-muted">
            The agent paused this action until a teammate approves it.
          </p>
          <p className="font-mono text-[10px] break-all text-foreground-muted">
            Action {approval.actionId}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant={approved ? "outline" : "default"}
          loading={loading}
          disabled={disabled || approved}
          onClick={onApprove}
        >
          <Check className="size-3.5" />
          {approved ? "Approved" : "Approve action"}
        </Button>
      </div>
    </div>
  )
}

function noteList(value: unknown) {
  const record = asRecord(value)
  return asList<Note>(record.items ?? value)
}

function macroList(value: unknown) {
  const record = asRecord(value)
  return asList<Macro>(record.items ?? value)
}

function teamList(value: unknown) {
  const record = asRecord(value)
  return asList<Team>(record.items ?? value)
}

function routingList(value: unknown) {
  const record = asRecord(value)
  return asList<RoutingRule>(record.items ?? value)
}

function surveyList(value: unknown) {
  const record = asRecord(value)
  return asList<Survey>(record.items ?? value)
}

export function InboxPage({
  view = "inbox",
  fixedAgentId,
}: {
  view?: "inbox" | "conversations"
  fixedAgentId?: string
}) {
  const isInbox = view === "inbox"
  const showAgentColumn = !isInbox && !fixedAgentId
  const scope = useWorkspaceStorageScope()
  const navigation = useInboxNavigation()
  const { isMobile, setOpenMobile } = useSidebar()
  const isWide = useWideViewport(900)
  const tableView = useTableView({
    settingsStorageKey: `datool:build-${view}:${scope}:settings`,
    orderStorageKey: `datool.build-${view}.columns`,
  })
  const agentId = fixedAgentId || navigation.params.get("agentId") || undefined
  const agent = useRemote(
    (signal) =>
      agentId
        ? buildApi.call<{ name: string }>(
            "build_get_agent",
            { agentId, includeArchived: true },
            signal
          )
        : Promise.resolve(null),
    [scope, agentId],
    { enabled: Boolean(agentId) && !fixedAgentId }
  )
  const search = navigation.params.get("q") ?? ""
  const setSearch = (value: string) =>
    navigation.navigate({ q: value || null }, true)
  const requestedStatus = navigation.params.get("status") ?? ""
  const status =
    isInbox && navigation.view === "solved"
      ? "solved"
      : (isInbox
            ? ["open", "pending", "snoozed", "solved", "closed"]
            : ["active", "handed_off", "closed", "blocked"]
          ).includes(requestedStatus)
        ? requestedStatus
        : ""
  const queue =
    isInbox && ["mine", "mentions", "unassigned"].includes(navigation.view)
      ? navigation.view
      : undefined
  const setStatus = (value: string) =>
    navigation.navigate({ status: value || null })
  const [showSetup, setShowSetup] = React.useState(false)
  const selectionKey = isInbox ? "ticket" : "conversation"
  const selectedId = navigation.params.get(selectionKey)
  const setSelectedId = (id: string | null) =>
    navigation.navigate({ [selectionKey]: id })
  const returnFocusRef = React.useRef<HTMLElement | null>(null)
  const closeConversation = () => {
    setSelectedId(null)
    returnFocusRef.current?.focus()
  }
  const tickets = useCollectionPages(
    isInbox ? listTickets : listConversations,
    JSON.stringify({ search, status, queue, agentId }),
    15_000,
    { refreshLoadedPages: true }
  )
  const recent = useRemote(
    (signal) =>
      buildApi
        .call(
          "build_list_tickets",
          { order: "recent", limit: 8, agentId },
          signal
        )
        .then(ticketList),
    [scope, agentId],
    { enabled: isInbox, intervalMs: 15_000 }
  )
  const selectedRow =
    tickets.items.find((ticket) => ticket.id === selectedId) ?? null
  const detail = useRemote(
    (signal) =>
      isInbox && selectedId
        ? buildApi
            .call<unknown>("build_get_ticket", { id: selectedId }, signal)
            .then(detailFrom)
        : Promise.resolve(null),
    [selectedId, isInbox],
    { enabled: isInbox && !!selectedId, intervalMs: 15_000 }
  )
  const selected = detail.data?.id === selectedId ? detail.data : selectedRow

  return (
    <>
      {isInbox ? (
        <InboxConversations>
          {recent.isLoading ? (
            <p
              role="status"
              className="px-2 py-3 text-xs text-foreground-muted"
            >
              Loading conversations…
            </p>
          ) : recent.error ? (
            <div className="space-y-2 px-2 py-3 text-xs text-foreground-muted">
              <p>Could not load recent conversations.</p>
              <Button size="sm" variant="outline" onClick={recent.refresh}>
                Retry
              </Button>
            </div>
          ) : recent.data?.items.length ? (
            <SidebarMenu aria-label="Recent conversations">
              {recent.data.items.map((ticket) => (
                <SidebarMenuItem key={ticket.id}>
                  <SidebarMenuButton
                    title={
                      ticket.subject ||
                      ticket.contactName ||
                      "Untitled conversation"
                    }
                    isActive={selectedId === ticket.id}
                    aria-current={selectedId === ticket.id ? "page" : undefined}
                    render={
                      <a
                        href={navigation.href({ ticket: ticket.id, new: null })}
                      />
                    }
                    onClick={(event) => {
                      if (
                        event.button !== 0 ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return
                      event.preventDefault()
                      returnFocusRef.current = event.currentTarget
                      setSelectedId(ticket.id)
                      if (isMobile) setOpenMobile(false)
                    }}
                  >
                    <productIcons.buildConversations />
                    <span>
                      {ticket.subject ||
                        ticket.contactName ||
                        "Untitled conversation"}
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          ) : (
            <p className="px-2 py-3 text-xs text-foreground-muted">
              No conversations yet.
            </p>
          )}
        </InboxConversations>
      ) : null}
      <CollectionPanel
        label={isInbox ? "Inbox" : "Conversations"}
        refreshInMenu={isInbox}
        compactToolbar={isInbox}
        contentClassName={isInbox ? "px-2 py-2" : undefined}
      >
        <CollectionPage
          className="contents"
          state={tickets}
          loadingLabel="Loading conversations"
          loadingContent={isInbox ? <ConversationListSkeleton /> : undefined}
          pagination={tickets}
          toolbar={
            <>
              {isInbox ? (
                <div
                  role="group"
                  aria-label="Inbox queues"
                  className="flex gap-1.5 overflow-x-auto px-1 pt-1 pb-3"
                >
                  {[
                    { label: "Open", view: "all", status: "open" },
                    { label: "Mine", view: "mine", status: "" },
                    { label: "Unassigned", view: "unassigned", status: "" },
                    { label: "Mentions", view: "mentions", status: "" },
                    { label: "Solved", view: "solved", status: "solved" },
                    { label: "All", view: "all", status: "" },
                  ].map((item) => (
                    <InboxQueueChip
                      key={item.label}
                      selected={
                        navigation.view === item.view && status === item.status
                      }
                      onClick={() =>
                        navigation.navigate({
                          view: item.view,
                          status: item.status || null,
                        })
                      }
                    >
                      {item.label}
                    </InboxQueueChip>
                  ))}
                  {["pending", "snoozed", "closed"].includes(status) && (
                    <InboxQueueChip
                      selected
                      onClick={() => setStatus("")}
                      aria-label={`Clear ${status} filter`}
                    >
                      <TicketStatusIndicator status={status} />
                      <X className="size-3" />
                    </InboxQueueChip>
                  )}
                </div>
              ) : null}
              {agentId && !fixedAgentId ? (
                <div className="flex min-w-0 items-center gap-2 px-3 py-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="max-w-full"
                    aria-label={`Remove agent filter: ${agent.data?.name || agentId}`}
                    onClick={() =>
                      navigation.navigate({
                        agentId: null,
                        [selectionKey]: null,
                      })
                    }
                  >
                    <Bot aria-hidden className="size-3.5 shrink-0" />
                    <span className="truncate">
                      Agent: {agent.data?.name || agentId}
                    </span>
                    <X aria-hidden className="size-3.5 shrink-0" />
                  </Button>
                </div>
              ) : null}
              {tableView.storageError ? (
                <Notice variant="error">{tableView.storageError}</Notice>
              ) : null}
            </>
          }
          header={{
            exportRows: tickets.items,
            exportName: view,
            children: (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {!isInbox ? (
                  <span className="shrink-0 text-sm font-medium">
                    Conversations
                  </span>
                ) : null}
                <CollectionSearch
                  label="Search conversations"
                  value={search}
                  onChange={setSearch}
                  focusRequest={Number(navigation.params.get("search")) || 0}
                />
                {!isInbox && (
                  <ConversationStatusSelect
                    value={status}
                    onValueChange={setStatus}
                  />
                )}
              </div>
            ),
            menuActions: isInbox ? (
              <>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <ListFilter className="size-3.5" />
                    Status
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuRadioGroup
                      value={status}
                      onValueChange={(value) =>
                        navigation.navigate({
                          status: value || null,
                          view:
                            navigation.view === "solved"
                              ? "all"
                              : navigation.view,
                        })
                      }
                    >
                      <DropdownMenuRadioItem value="">
                        All statuses
                      </DropdownMenuRadioItem>
                      {["open", "pending", "snoozed", "solved", "closed"].map(
                        (value) => (
                          <DropdownMenuRadioItem key={value} value={value}>
                            <TicketStatusIndicator status={value} />
                          </DropdownMenuRadioItem>
                        )
                      )}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem onSelect={() => setShowSetup(true)}>
                  <Settings2 className="size-3.5" />
                  Inbox settings
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            ) : undefined,
          }}
          isEmpty={!tickets.items.length}
          empty={
            <BuildEmpty
              title={
                search
                  ? "No matching conversations"
                  : isInbox
                    ? "No escalated conversations"
                    : "No conversations yet"
              }
              description={
                search
                  ? "Try another subject, customer name, email or conversation ID."
                  : !isInbox
                    ? fixedAgentId
                      ? "This agent’s customer conversations appear here, including chats that never need human help."
                      : "All customer conversations appear here, including chats that never need human help."
                    : navigation.view === "mentions"
                      ? "Tickets appear here when a teammate mentions your @email in an internal note."
                      : navigation.view === "mine"
                        ? "Tickets assigned to you appear here."
                        : "Conversations appear here when they are escalated for human help."
              }
              action={
                search || status || queue ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      navigation.navigate({
                        q: null,
                        status: null,
                        view: "all",
                      })
                    }}
                  >
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          }
        >
          {isInbox ? (
            <div
              aria-label="Inbox conversations"
              className="min-w-0 divide-y divide-border"
            >
              {tickets.items.map((ticket) => (
                <ConversationRow
                  key={ticket.id}
                  selected={ticket.id === selectedId}
                  aria-label={`Open ${ticket.contactName || ticket.subject || "conversation"}`}
                  onClick={(event) => {
                    returnFocusRef.current = event.currentTarget
                    setSelectedId(ticket.id)
                  }}
                  avatar={
                    <ConversationAvatar
                      name={ticket.contactName || ticket.subject || "Customer"}
                      identity={
                        ticket.contactId || ticket.conversationId || ticket.id
                      }
                      badge={
                        ticket.channel ? (
                          <ChannelIcon channel={ticket.channel} size="sm" />
                        ) : undefined
                      }
                    />
                  }
                  title={
                    ticket.contactName ||
                    ticket.subject ||
                    "Customer conversation"
                  }
                  preview={ticket.subject || "No subject"}
                  timestamp={
                    ticket.updatedAt ? (
                      <time
                        dateTime={ticket.updatedAt}
                        title={new Date(ticket.updatedAt).toLocaleString()}
                      >
                        {new Date(ticket.updatedAt).toLocaleDateString([], {
                          month: "short",
                          day: "numeric",
                        })}
                      </time>
                    ) : undefined
                  }
                  metadata={
                    <>
                      <TicketStatusIndicator status={ticket.status} />
                      <span className="truncate">
                        {ticket.assigneeName || ticket.teamName || "Unassigned"}
                      </span>
                      {["high", "urgent"].includes(ticket.priority || "") && (
                        <PriorityIndicator priority={ticket.priority} />
                      )}
                    </>
                  }
                />
              ))}
            </div>
          ) : (
            <CollectionTable
              fillHeight
              selectionColumnWidth={0}
              enableCardView
              settings={tableView.settings}
              onSettingsChange={tableView.onSettingsChange}
              columnOrderStore={tableView.columnOrderStore}
              widths={
                isInbox
                  ? [330, 220, 130, 120, 120, 160, 200]
                  : [330, 220, ...(showAgentColumn ? [220] : []), 130, 120, 200]
              }
              columnIds={[
                "subject",
                "customer",
                ...(showAgentColumn ? ["agent"] : []),
                "channel",
                "status",
                ...(isInbox ? ["priority", "assignment"] : []),
                "updated",
              ]}
              reorderable
            >
              <thead className={collectionTable.head}>
                <tr>
                  <th aria-hidden className="p-0" />
                  {[
                    "Conversation",
                    "Customer",
                    ...(showAgentColumn ? ["Agent"] : []),
                    "Channel",
                    "Status",
                    ...(isInbox ? ["Priority", "Assignment"] : []),
                    "Updated",
                  ].map((label) => (
                    <th key={label} className={collectionTable.heading}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <CollectionTableBody rows={tickets.items}>
                {(ticket) => (
                  <CollectionRow
                    key={ticket.id}
                    active={ticket.id === selectedId}
                    rowLabel={ticket.subject || "Conversation"}
                    tabIndex={0}
                    aria-label={`Open ${ticket.subject || ticket.contactName || "conversation"}`}
                    onClick={(event) => {
                      returnFocusRef.current = event.currentTarget
                      setSelectedId(ticket.id)
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.target === event.currentTarget &&
                        (event.key === "Enter" || event.key === " ")
                      ) {
                        event.preventDefault()
                        returnFocusRef.current = event.currentTarget
                        setSelectedId(ticket.id)
                      }
                    }}
                  >
                    <td aria-hidden className="p-0" />
                    <td className={collectionTable.cell}>
                      <span className="flex min-w-0 items-center gap-2 font-medium">
                        <ConversationAvatar
                          size="sm"
                          name={
                            ticket.contactName || ticket.subject || "Customer"
                          }
                          identity={
                            ticket.contactId ||
                            ticket.conversationId ||
                            ticket.id
                          }
                        />
                        <span className="truncate">
                          {ticket.subject || "Untitled conversation"}
                        </span>
                      </span>
                    </td>
                    <td className={collectionTable.cell}>
                      {ticket.contactName || "Unknown customer"}
                    </td>
                    {showAgentColumn ? (
                      <td className={collectionTable.cell}>
                        <span className="flex min-w-0 items-center gap-2">
                          <AgentAvatar
                            appearance={ticket.agentAvatar ?? undefined}
                            className="size-5"
                          />
                          <span className="truncate">
                            {ticket.agentName || "Unknown agent"}
                          </span>
                        </span>
                      </td>
                    ) : null}
                    <td className={collectionTable.cell}>
                      <span className="inline-flex items-center gap-2 capitalize">
                        {ticket.channel ? (
                          <ChannelIcon channel={ticket.channel} size="sm" />
                        ) : null}
                        {ticket.channel === "web"
                          ? "Website"
                          : ticket.channel || "—"}
                      </span>
                    </td>
                    <td className={collectionTable.cell}>
                      {isInbox ? (
                        <TicketStatusIndicator status={ticket.status} />
                      ) : (
                        <ConversationStatusBadge
                          status={ticket.conversationStatus}
                        />
                      )}
                    </td>
                    {isInbox ? (
                      <>
                        <td className={collectionTable.cell}>
                          <PriorityIndicator priority={ticket.priority} />
                        </td>
                        <td className={collectionTable.cell}>
                          <span className="flex min-w-0 items-center gap-2">
                            {ticket.assigneeName || ticket.teamName ? (
                              <UserAvatarImage
                                name={ticket.assigneeName || ticket.teamName!}
                                image={ticket.assigneeImage ?? null}
                              />
                            ) : null}
                            <span className="truncate text-foreground-muted">
                              {ticket.assigneeName ||
                                ticket.teamName ||
                                (ticket.assigneeUserId
                                  ? "Assigned teammate"
                                  : "Unassigned")}
                            </span>
                          </span>
                        </td>
                      </>
                    ) : null}
                    <td className={collectionTable.cell}>
                      <span className="text-foreground-muted">
                        {ticket.updatedAt
                          ? new Date(ticket.updatedAt).toLocaleString()
                          : "—"}
                      </span>
                    </td>
                  </CollectionRow>
                )}
              </CollectionTableBody>
            </CollectionTable>
          )}
        </CollectionPage>
      </CollectionPanel>
      {selectedId ? (
        <CollectionInspectorOverlay
          title="Conversation details"
          description="Read messages, reply, and manage this conversation."
          isWide={isWide}
          defaultSize={68}
          onClose={closeConversation}
          onRestoreFocus={() => returnFocusRef.current?.focus()}
        >
          {selected ? (
            <InboxInspector
              key={selected.id}
              ticket={selected}
              isLoading={detail.isLoading}
              error={detail.error}
              onClose={closeConversation}
              onChanged={() => {
                tickets.refresh()
                recent.refresh()
                detail.refresh()
              }}
            />
          ) : (
            <div className="p-4">
              <Button variant="ghost" onClick={closeConversation}>
                Close conversation
              </Button>
              <BuildState
                isLoading={detail.isLoading}
                error={detail.error}
                onRetry={detail.refresh}
              >
                {null}
              </BuildState>
            </div>
          )}
        </CollectionInspectorOverlay>
      ) : null}
      {isInbox && navigation.params.get("new") === "ticket" ? (
        <NewTicketDialog
          initialAgentId={agentId}
          onClose={() => navigation.navigate({ new: null }, true)}
          onCreated={(id) => {
            navigation.navigate(
              { new: null, ticket: id, view: "all", status: null, q: null },
              true
            )
            tickets.refresh()
            recent.refresh()
          }}
        />
      ) : null}
      <Sheet open={showSetup} onOpenChange={setShowSetup}>
        <SheetContent>
          <SheetHeader className="border-b border-border px-5 py-4 pr-12">
            <SheetTitle>Inbox settings</SheetTitle>
            <SheetDescription>
              Manage teams, routing rules, saved replies and satisfaction
              surveys.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {showSetup ? <InboxOperationsPanel ticket={selected} /> : null}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

function InboxOperationsPanel({ ticket }: { ticket: Ticket | null }) {
  const teams = useRemote(
    (signal) =>
      buildApi.call<unknown>("build_list_teams", {}, signal).then(teamList),
    [],
    { intervalMs: 30_000 }
  )
  const routing = useRemote(
    (signal) =>
      buildApi
        .call<unknown>("build_list_routing_rules", {}, signal)
        .then(routingList),
    [],
    { intervalMs: 30_000 }
  )
  const macros = useRemote(
    (signal) =>
      buildApi.call<unknown>("build_list_macros", {}, signal).then(macroList),
    [],
    { intervalMs: 30_000 }
  )
  const surveys = useRemote(
    (signal) =>
      buildApi
        .call<unknown>(
          "build_list_csat",
          { status: "pending", limit: 50 },
          signal
        )
        .then(surveyList),
    [],
    { intervalMs: 30_000 }
  )
  const createTeam = useMutation()
  const createRule = useMutation()
  const createMacro = useMutation()
  const requestSurvey = useMutation()
  const [teamName, setTeamName] = React.useState("")
  const [teamDescription, setTeamDescription] = React.useState("")
  const [ruleName, setRuleName] = React.useState("")
  const [rulePriority, setRulePriority] = React.useState("100")
  const [ruleTeamId, setRuleTeamId] = React.useState("")
  const [ruleAssignee, setRuleAssignee] = React.useState("")
  const [ruleConditions, setRuleConditions] = React.useState(
    '{"channel":"telegram"}'
  )
  const [macroName, setMacroName] = React.useState("")
  const [macroBody, setMacroBody] = React.useState("")
  const [panelError, setPanelError] = React.useState<string | null>(null)

  async function submitTeam(event: React.FormEvent) {
    event.preventDefault()
    if (!teamName.trim()) return
    try {
      await createTeam.run(() =>
        buildApi.call("build_create_team", {
          name: teamName.trim(),
          description: teamDescription.trim(),
          enabled: true,
        })
      )
      setTeamName("")
      setTeamDescription("")
      teams.refresh()
    } catch {
      // useMutation exposes the failure in the card below the form.
    }
  }

  async function submitRule(event: React.FormEvent) {
    event.preventDefault()
    if (!ruleName.trim() || (!ruleTeamId && !ruleAssignee.trim())) return
    let conditions: unknown = {}
    try {
      conditions = JSON.parse(ruleConditions)
    } catch {
      setPanelError("Routing conditions must be valid JSON.")
      return
    }
    if (
      !conditions ||
      typeof conditions !== "object" ||
      Array.isArray(conditions)
    ) {
      setPanelError("Routing conditions must be a JSON object.")
      return
    }
    setPanelError(null)
    try {
      await createRule.run(() =>
        buildApi.call("build_create_routing_rule", {
          name: ruleName.trim(),
          priority: Number(rulePriority) || 100,
          conditions,
          teamId: ruleTeamId || null,
          assigneeUserId: ruleAssignee.trim() || null,
          enabled: true,
        })
      )
      setRuleName("")
      routing.refresh()
    } catch {
      // useMutation exposes the failure in the card below the form.
    }
  }

  async function submitMacro(event: React.FormEvent) {
    event.preventDefault()
    if (!macroName.trim() || !macroBody.trim()) return
    try {
      await createMacro.run(() =>
        buildApi.call("build_create_macro", {
          name: macroName.trim(),
          body: macroBody.trim(),
          enabled: true,
        })
      )
      setMacroName("")
      setMacroBody("")
      macros.refresh()
    } catch {
      // useMutation exposes the failure in the card below the form.
    }
  }

  async function requestSurveyForTicket() {
    if (!ticket) return
    try {
      await requestSurvey.run(() =>
        buildApi.call("build_request_csat", {
          ticketId: ticket.id,
          conversationId: ticket.conversationId ?? undefined,
          contactId: ticket.contactId ?? undefined,
          ...(ticket.channel ? { channel: ticket.channel } : {}),
        })
      )
      surveys.refresh()
    } catch {
      // useMutation exposes the failure in the card below the form.
    }
  }

  return (
    <div className="grid gap-4">
      <BuildFormCard
        title="Support teams"
        description="Teams and member counts used by inbox assignment and routing."
        footer={null}
      >
        <div className="space-y-2">
          {teams.isLoading ? (
            <p className="text-xs text-foreground-muted">Loading teams…</p>
          ) : null}
          {teams.error ? (
            <Notice variant="error">{teams.error.message}</Notice>
          ) : null}
          {teams.data?.map((team) => (
            <div
              key={team.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{team.name}</span>
                <span className="block truncate text-foreground-muted">
                  {team.memberCount ?? 0} members ·{" "}
                  {team.enabled === false ? "disabled" : "enabled"}
                </span>
              </span>
            </div>
          ))}
          {!teams.isLoading && !teams.error && !teams.data?.length ? (
            <p className="text-xs text-foreground-muted">
              No support teams yet.
            </p>
          ) : null}
        </div>
        <form
          className="mt-3 space-y-2 border-t border-border pt-3"
          onSubmit={(event) => void submitTeam(event)}
        >
          <Input
            value={teamName}
            onChange={(event) => setTeamName(event.target.value)}
            placeholder="Team name"
            aria-label="Team name"
          />
          <Input
            value={teamDescription}
            onChange={(event) => setTeamDescription(event.target.value)}
            placeholder="Description (optional)"
            aria-label="Team description"
          />
          <Button
            size="sm"
            type="submit"
            loading={createTeam.isPending}
            disabled={!teamName.trim()}
          >
            <UserRound className="size-3.5" /> Create team
          </Button>
        </form>
        {createTeam.error ? (
          <Notice className="mt-2" variant="error">
            {createTeam.error.message}
          </Notice>
        ) : null}
      </BuildFormCard>
      <BuildFormCard
        title="Routing rules"
        description="Route new inbox tickets by channel, priority, tags or contact status."
        footer={null}
      >
        <div className="space-y-2">
          {routing.isLoading ? (
            <p className="text-xs text-foreground-muted">Loading rules…</p>
          ) : null}
          {routing.error ? (
            <Notice variant="error">{routing.error.message}</Notice>
          ) : null}
          {routing.data?.map((rule) => (
            <div
              key={rule.id}
              className="rounded-md border border-border bg-background px-3 py-2 text-xs"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{rule.name}</span>
                <span className="text-foreground-muted">
                  Priority {rule.priority ?? 0}
                </span>
              </div>
              <p className="mt-1 text-foreground-muted">
                {rule.teamId
                  ? "Assigned to a team"
                  : rule.assigneeUserId
                    ? "Assigned to a teammate"
                    : "Unassigned"}{" "}
                · {rule.enabled === false ? "disabled" : "enabled"}
              </p>
            </div>
          ))}
          {!routing.isLoading && !routing.error && !routing.data?.length ? (
            <p className="text-xs text-foreground-muted">
              No routing rules yet.
            </p>
          ) : null}
        </div>
        <form
          className="mt-3 space-y-2 border-t border-border pt-3"
          onSubmit={(event) => void submitRule(event)}
        >
          <Input
            value={ruleName}
            onChange={(event) => setRuleName(event.target.value)}
            placeholder="Rule name"
            aria-label="Routing rule name"
          />
          <div className="grid grid-cols-2 gap-2">
            <Input
              type="number"
              min={0}
              value={rulePriority}
              onChange={(event) => setRulePriority(event.target.value)}
              placeholder="Priority"
              aria-label="Routing priority"
            />
            <Select
              value={ruleTeamId}
              onChange={(event) => setRuleTeamId(event.target.value)}
              aria-label="Routing team"
            >
              <option value="">Team…</option>
              {teams.data
                ?.filter((team) => team.enabled !== false)
                .map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
            </Select>
          </div>
          <Input
            value={ruleAssignee}
            onChange={(event) => setRuleAssignee(event.target.value)}
            placeholder="Assignee user ID (optional)"
            aria-label="Routing assignee"
          />
          <Textarea
            rows={2}
            value={ruleConditions}
            onChange={(event) => setRuleConditions(event.target.value)}
            aria-label="Routing conditions"
          />
          {panelError ? <Notice variant="error">{panelError}</Notice> : null}
          <Button
            size="sm"
            type="submit"
            loading={createRule.isPending}
            disabled={!ruleName.trim() || (!ruleTeamId && !ruleAssignee.trim())}
          >
            <Check className="size-3.5" /> Create rule
          </Button>
        </form>
        {createRule.error ? (
          <Notice className="mt-2" variant="error">
            {createRule.error.message}
          </Notice>
        ) : null}
      </BuildFormCard>
      <BuildFormCard
        title="Saved replies and CSAT"
        description="Manage macros for operators and track pending customer surveys."
        footer={null}
      >
        <div className="space-y-2">
          {macros.isLoading ? (
            <p className="text-xs text-foreground-muted">Loading macros…</p>
          ) : null}
          {macros.error ? (
            <Notice variant="error">{macros.error.message}</Notice>
          ) : null}
          {macros.data?.map((macro) => (
            <div
              key={macro.id}
              className="rounded-md border border-border bg-background px-3 py-2 text-xs"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{macro.name}</span>
                <span className="text-foreground-muted">
                  {macro.enabled === false ? "disabled" : "enabled"}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-foreground-muted">
                {macro.body}
              </p>
            </div>
          ))}
          {!macros.isLoading && !macros.error && !macros.data?.length ? (
            <p className="text-xs text-foreground-muted">
              No saved replies yet.
            </p>
          ) : null}
        </div>
        <form
          className="mt-3 space-y-2 border-t border-border pt-3"
          onSubmit={(event) => void submitMacro(event)}
        >
          <Input
            value={macroName}
            onChange={(event) => setMacroName(event.target.value)}
            placeholder="Macro name"
            aria-label="Macro name"
          />
          <Textarea
            rows={2}
            value={macroBody}
            onChange={(event) => setMacroBody(event.target.value)}
            placeholder="Reply body"
            aria-label="Macro body"
          />
          <Button
            size="sm"
            type="submit"
            loading={createMacro.isPending}
            disabled={!macroName.trim() || !macroBody.trim()}
          >
            <Send className="size-3.5" /> Create macro
          </Button>
        </form>
        {createMacro.error ? (
          <Notice className="mt-2" variant="error">
            {createMacro.error.message}
          </Notice>
        ) : null}
        <div className="mt-3 border-t border-border pt-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-foreground-muted">
              Pending CSAT
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void requestSurveyForTicket()}
              disabled={!ticket}
              loading={requestSurvey.isPending}
            >
              Request for selected
            </Button>
          </div>
          {surveys.error ? (
            <Notice className="mt-2" variant="error">
              {surveys.error.message}
            </Notice>
          ) : null}
          {surveys.data?.length ? (
            <div className="mt-2 space-y-1">
              {surveys.data.slice(0, 5).map((survey) => (
                <div
                  key={survey.id}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="truncate text-foreground-muted">
                    {survey.ticketId || survey.conversationId || survey.id}
                  </span>
                  <BuildStatus status={survey.status} />
                </div>
              ))}
            </div>
          ) : !surveys.error ? (
            <p className="mt-2 text-xs text-foreground-muted">
              No pending surveys.
            </p>
          ) : null}
          {requestSurvey.error ? (
            <Notice className="mt-2" variant="error">
              {requestSurvey.error.message}
            </Notice>
          ) : null}
        </div>
      </BuildFormCard>
    </div>
  )
}

function InboxInspector({
  ticket,
  isLoading,
  error,
  onClose,
  onChanged,
}: {
  ticket: Ticket | null
  isLoading: boolean
  error: Error | null
  onClose: () => void
  onChanged: () => void
}) {
  const href = useWorkspaceHref()
  const [activeTab, setActiveTab] = React.useState("conversation")
  const [message, setMessage] = React.useState("")
  const [note, setNote] = React.useState("")
  const update = useMutation()
  const send = useMutation()
  const addNote = useMutation()
  const takeover = useMutation()
  const approve = useMutation()
  const applyMacroAction = useMutation()
  const rateResponse = useMutation()
  const [ratings, setRatings] = React.useState<
    Record<string, ChatFeedbackValue>
  >({})
  const [approvedContinuationIds, setApprovedContinuationIds] = React.useState<
    Set<string>
  >(() => new Set())
  const [optimisticMacroVersion, setOptimisticMacroVersion] = React.useState<{
    ticketId: string
    version: number
  } | null>(null)
  const conversationId = ticket?.conversationId ?? ""
  const ticketId = ticket?.ticketId !== undefined ? ticket.ticketId : ticket?.id
  const linkedTicket = useRemote(
    (signal) =>
      ticket?.ticketId
        ? buildApi
            .call<unknown>("build_get_ticket", { id: ticket.ticketId }, signal)
            .then(detailFrom)
        : Promise.resolve(null),
    [ticket?.ticketId],
    { enabled: !!ticket?.ticketId, intervalMs: 15_000 }
  )
  const conversation = useRemote(
    (signal) =>
      conversationId
        ? buildApi
            .call<unknown>("build_get_conversation", { conversationId }, signal)
            .then(conversationFrom)
        : Promise.resolve<Record<string, unknown> | null>(null),
    [conversationId],
    { enabled: !!conversationId, intervalMs: 5_000 }
  )
  const messages = useRemote(
    (signal) =>
      conversationId
        ? buildApi
            .call<unknown>(
              "build_list_conversation_messages",
              { conversationId, limit: 100 },
              signal
            )
            .then(messageList)
        : Promise.resolve<Message[]>([]),
    [conversationId],
    { enabled: !!conversationId, intervalMs: 5_000 }
  )
  const notes = useRemote(
    (signal) =>
      ticketId
        ? buildApi
            .call<unknown>("build_list_ticket_notes", { ticketId }, signal)
            .then(noteList)
        : Promise.resolve<Note[]>([]),
    [ticketId],
    { enabled: !!ticketId }
  )
  const ownershipState = useRemote(
    (signal) =>
      conversationId
        ? buildApi.call<unknown>(
            "build_get_conversation_ownership",
            { conversationId },
            signal
          )
        : Promise.resolve(null),
    [conversationId],
    { enabled: !!conversationId, intervalMs: 5_000 }
  )
  const macros = useRemote(
    (signal) =>
      buildApi.call<unknown>("build_list_macros", {}, signal).then(macroList),
    [],
    { intervalMs: 30_000 }
  )
  const resolvedTicket = ticket
    ? {
        ...ticket,
        ...linkedTicket.data,
        messages: messages.data ?? [],
        notes: notes.data ?? [],
        macros: macros.data ?? [],
        ownerType:
          !ownershipState.error &&
          asRecord(ownershipState.data).mode === "human"
            ? "human"
            : conversation.data?.ownerType === "human"
              ? "human"
              : "ai",
        ownerId:
          (asRecord(ownershipState.data).ownerUserId as
            string | null | undefined) ??
          (conversation.data?.ownerId as string | null | undefined) ??
          null,
        externalConversationId:
          (conversation.data?.externalConversationId as
            string | null | undefined) ?? ticket.externalConversationId,
      }
    : null
  function refreshInspector() {
    onChanged()
    conversation.refresh()
    messages.refresh()
    notes.refresh()
    linkedTicket.refresh()
    ownershipState.refresh()
  }

  if (!resolvedTicket)
    return (
      <BuildEmpty
        title="Select a conversation"
        description="Choose an inbox row to inspect its messages and controls."
      />
    )
  const activeTicket = resolvedTicket
  const ticketVersion =
    optimisticMacroVersion &&
    optimisticMacroVersion.ticketId === ticketId &&
    (typeof activeTicket.version !== "number" ||
      activeTicket.version < optimisticMacroVersion.version)
      ? optimisticMacroVersion.version
      : activeTicket.version
  const ownershipAvailable =
    Boolean(conversationId) &&
    !ownershipState.isLoading &&
    !ownershipState.error

  async function statusChange(value: string) {
    if (!ticketId) return
    try {
      await update.run(() =>
        buildApi.call("build_update_ticket", {
          id: ticketId,
          status: value,
          expectedVersion: ticketVersion,
        })
      )
      refreshInspector()
    } catch {
      // The mutation error is rendered beside the status control.
    }
  }
  async function submitMessage(event: React.FormEvent) {
    event.preventDefault()
    if (
      !message.trim() ||
      activeTicket.ownerType !== "human" ||
      !activeTicket.conversationId
    )
      return
    try {
      await send.run(() =>
        buildApi.call("build_send_human_reply", {
          conversationId: activeTicket.conversationId!,
          externalConversationId:
            activeTicket.externalConversationId ?? undefined,
          text: message.trim(),
          clientMessageId: crypto.randomUUID(),
        })
      )
      setMessage("")
      refreshInspector()
    } catch {
      // The mutation error remains visible in the Reply card.
    }
  }
  async function submitFeedback(value: ChatFeedbackValue, response: Message) {
    if (!response.id || !conversationId) return
    const responseIndex = activeTicket.messages.findIndex(
      (item) => item.id === response.id
    )
    const question = activeTicket.messages
      .slice(0, responseIndex)
      .reverse()
      .find((item) => item.role === "user" || item.direction === "inbound")
    try {
      await rateResponse.run(() =>
        buildApi.call("build_record_feedback", {
          conversationId,
          channel: activeTicket.channel ?? undefined,
          question: (question
            ? messageText(question, null)
            : "Conversation response"
          ).slice(0, 4000),
          sentiment: value,
          reason: "Operator review",
          metadata: { source: "inbox-operator", messageId: response.id! },
        })
      )
      setRatings((current) => ({ ...current, [response.id!]: value }))
    } catch {
      // Keep the previous rating and show the request error.
    }
  }
  async function submitNote(event: React.FormEvent) {
    event.preventDefault()
    if (!ticketId || !note.trim()) return
    try {
      await addNote.run(() =>
        buildApi.call("build_add_ticket_note", {
          ticketId,
          body: note.trim(),
        })
      )
      setNote("")
      refreshInspector()
    } catch {
      // The mutation error remains visible in the Internal notes card.
    }
  }
  async function ownership(mode: "takeover" | "resume") {
    if (!activeTicket.conversationId) {
      try {
        await takeover.run(async () => {
          throw new Error("This ticket has no linked conversation to hand off.")
        })
      } catch {
        // The mutation error is rendered in the ownership card.
      }
      return
    }
    const ownershipRecord = asRecord(ownershipState.data)
    const version = Number(ownershipRecord.version ?? 0)
    if (mode === "resume" && (!Number.isInteger(version) || version <= 0)) {
      await takeover
        .run(async () => {
          throw new Error(
            "Ownership state is still loading. Refresh before resuming AI."
          )
        })
        .catch(() => undefined)
      return
    }
    const input = {
      conversationId: activeTicket.conversationId,
      ...(version > 0 ? { expectedVersion: version } : {}),
      ...(mode === "resume" && typeof ownershipRecord.leaseToken === "string"
        ? { leaseToken: ownershipRecord.leaseToken }
        : {}),
    }
    try {
      await takeover.run(() =>
        buildApi.call(
          mode === "takeover"
            ? "build_takeover_conversation"
            : "build_resume_conversation",
          input
        )
      )
      refreshInspector()
    } catch {
      // The mutation error is rendered in the ownership card.
    }
  }

  async function approveAction(approval: ApprovalContinuation) {
    if (!activeTicket.conversationId) return
    try {
      const result = await approve.run(() =>
        buildApi.call<{ status?: string }>(
          "build_approve_conversation_action",
          {
            conversationId: activeTicket.conversationId!,
            actionId: approval.actionId,
            continuationId: approval.continuationId,
          }
        )
      )
      const status = asRecord(result).status
      if (
        !["completed", "awaiting_client", "handed_off", "replayed"].includes(
          typeof status === "string" ? status : ""
        )
      ) {
        throw new Error("The action was not completed after approval.")
      }
      setApprovedContinuationIds((current) => {
        const next = new Set(current)
        next.add(approval.continuationId)
        return next
      })
      refreshInspector()
    } catch {
      // The mutation error remains visible beside the approval control.
    }
  }

  async function applyMacro(macro: Macro) {
    if (!ticketId) return
    const expectedVersion = ticketVersion
    if (
      !Number.isInteger(expectedVersion) ||
      !expectedVersion ||
      expectedVersion < 1
    )
      return
    try {
      const result = await applyMacroAction.run(() =>
        buildApi.call("build_apply_macro", {
          macroId: macro.id,
          ticketId,
          expectedVersion,
        })
      )
      const returnedVersion = Number(asRecord(result).version)
      setOptimisticMacroVersion({
        ticketId,
        version:
          Number.isInteger(returnedVersion) && returnedVersion > expectedVersion
            ? returnedVersion
            : expectedVersion + 1,
      })
      refreshInspector()
    } catch {
      // The mutation error remains visible beside the macro controls.
    }
  }

  const canReply = ownershipAvailable && activeTicket.ownerType === "human"

  const statusControl = ticketId ? (
    <TicketStatusSelect
      label="Ticket status"
      value={activeTicket.status ?? "open"}
      onValueChange={(value) => void statusChange(value)}
      disabled={
        update.isPending ||
        isLoading ||
        !!error ||
        linkedTicket.isLoading ||
        !!linkedTicket.error
      }
    />
  ) : (
    <ConversationStatusBadge
      status={
        typeof conversation.data?.status === "string"
          ? conversation.data.status
          : activeTicket.conversationStatus
      }
    />
  )
  const ownershipLabel = !ownershipAvailable
    ? ownershipState.error
      ? "Ownership unavailable"
      : "Checking ownership…"
    : activeTicket.ownerType === "human"
      ? "Handled by team"
      : "Handled by AI"
  const latestResponse = [...activeTicket.messages]
    .reverse()
    .find((item) => item.role === "assistant")
  const responseFeedback = latestResponse?.id
    ? {
        label: "Review latest response",
        value: ratings[latestResponse.id],
        onChange: (value: ChatFeedbackValue) =>
          void submitFeedback(value, latestResponse),
        disabled: rateResponse.isPending || !conversationId,
      }
    : undefined

  return (
    <aside
      aria-label="Conversation details"
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
    >
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="flex min-h-0 flex-1 flex-col"
      >
        <header className="shrink-0 border-b border-border px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex min-w-0 flex-1 basis-48 items-center gap-3">
              <ConversationAvatar
                size="md"
                name={activeTicket.contactName || "Customer"}
                identity={
                  activeTicket.contactId ||
                  activeTicket.conversationId ||
                  activeTicket.id
                }
                badge={
                  activeTicket.channel ? (
                    <ChannelIcon channel={activeTicket.channel} size="sm" />
                  ) : undefined
                }
              />
              <div className="min-w-0 flex-1">
                <h2
                  className="truncate text-sm leading-5 font-semibold"
                  title={activeTicket.subject || "Conversation"}
                >
                  {activeTicket.contactName || "Customer"}
                </h2>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-foreground-muted">
                  <span className="shrink-0 capitalize">
                    {activeTicket.channel === "web"
                      ? "Web chat"
                      : activeTicket.channel || "Conversation"}
                  </span>
                  <span aria-hidden>·</span>
                  <span role="status" className="truncate">
                    {ownershipLabel}
                  </span>
                </div>
              </div>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <>
                {statusControl}
                <TabsList aria-label="Conversation sections">
                  {[
                    {
                      value: "conversation",
                      label: "Conversation",
                      icon: MessageSquare,
                    },
                    ...(ticketId
                      ? [
                          {
                            value: "notes",
                            label: "Notes",
                            icon: StickyNote,
                          },
                          { value: "details", label: "Details", icon: Info },
                        ]
                      : []),
                  ].map(({ value, label, icon: Icon }) => (
                    <Tooltip key={value}>
                      <TooltipTrigger asChild>
                        <TabsTrigger
                          value={value}
                          size="icon"
                          aria-label={label}
                        >
                          <Icon aria-hidden />
                        </TabsTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        {label}
                        {value === "notes" && activeTicket.notes.length > 0
                          ? ` (${activeTicket.notes.length})`
                          : ""}
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </TabsList>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      aria-label="Conversation actions"
                      title="Conversation actions"
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      disabled={!ownershipAvailable || takeover.isPending}
                      onSelect={() =>
                        void ownership(
                          activeTicket.ownerType === "human"
                            ? "resume"
                            : "takeover"
                        )
                      }
                    >
                      {activeTicket.ownerType === "human" ? (
                        <Play className="size-4" />
                      ) : (
                        <UserRound className="size-4" />
                      )}
                      {activeTicket.ownerType === "human"
                        ? "Resume AI"
                        : "Take over"}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={refreshInspector}>
                      <RefreshCw className="size-4" />
                      Refresh conversation
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
              <Button
                size="icon-sm"
                variant="ghost-muted"
                aria-label="Close conversation"
                title="Close conversation"
                onClick={onClose}
              >
                <X className="size-4" />
              </Button>
            </div>
          </div>
          {error ? <Notice variant="error">{error.message}</Notice> : null}
          {linkedTicket.error ? (
            <Notice variant="error">
              Ticket details could not be loaded: {linkedTicket.error.message}
            </Notice>
          ) : null}
          {update.error ? (
            <Notice variant="error">{update.error.message}</Notice>
          ) : null}
          {takeover.error ? (
            <Notice variant="error">{takeover.error.message}</Notice>
          ) : null}
          {conversation.error ? (
            <Notice variant="error">{conversation.error.message}</Notice>
          ) : null}
          {ownershipState.error ? (
            <Notice variant="error">
              Ownership controls are unavailable: {ownershipState.error.message}
            </Notice>
          ) : null}
        </header>

        {conversationId && (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
            <Button size="sm" variant="ghost-muted" asChild>
              <Link
                href={href(
                  `/traces?${new URLSearchParams({
                    filter: `sessionId = ${JSON.stringify(conversationId)}`,
                  })}`
                )}
              >
                <productIcons.traces className="size-3.5" aria-hidden />
                View traces
              </Link>
            </Button>
            {ownershipAvailable && activeTicket.ownerType !== "human" && (
              <Button
                size="sm"
                variant="outline"
                loading={takeover.isPending}
                onClick={() => void ownership("takeover")}
              >
                <UserRound className="size-3.5" />
                Take over
              </Button>
            )}
          </div>
        )}
        <TabsContent
          value="conversation"
          className="flex min-h-0 flex-1 flex-col"
        >
          <Chat
            variant="inbox"
            perspective="operator"
            messages={activeTicket.messages.map((item) => ({
              id: item.id,
              author: item.author,
              role:
                item.role ||
                (item.direction === "inbound" ? "user" : "assistant"),
              content: item.text ?? item.content ?? "",
              metadata: {
                ...asRecord(item.content),
                ...asRecord(item.metadata),
              },
              attachments: item.attachments,
              createdAt: item.createdAt,
              status: item.status,
              toolCalls: [],
            }))}
            text={message}
            onTextChange={setMessage}
            onSubmit={(event) => void submitMessage(event)}
            running={send.isPending}
            loading={messages.isLoading}
            composerDisabled={!canReply}
            canSubmit={canReply && !!message.trim() && !send.isPending}
            placeholder={
              canReply
                ? "Message"
                : "Take over the conversation before replying…"
            }
            transcriptNotice={
              messages.error ? (
                <Notice variant="error">
                  Messages could not be loaded: {messages.error.message}
                </Notice>
              ) : null
            }
            renderMessageFooter={(item) => {
              const approval = approvalFromMessage(item)
              return (
                <>
                  {item.id === latestResponse?.id && responseFeedback && (
                    <div className="mt-1 flex justify-end">
                      <ChatFeedback {...responseFeedback} hideLabel />
                    </div>
                  )}
                  {approval ? (
                    <ApprovalActionCard
                      approval={approval}
                      approved={approvedContinuationIds.has(
                        approval.continuationId
                      )}
                      loading={approve.isPending}
                      disabled={
                        approve.isPending || !activeTicket.conversationId
                      }
                      onApprove={() => void approveAction(approval)}
                    />
                  ) : null}
                </>
              )
            }}
            composerFooter={
              <div className="mt-2 space-y-2">
                {!canReply ? (
                  <p className="text-xs text-foreground-muted" role="status">
                    {ownershipState.error
                      ? "Ownership controls are unavailable. Refresh before replying."
                      : ownershipState.isLoading
                        ? "Loading ownership state before enabling replies…"
                        : !conversationId
                          ? "This ticket has no linked conversation for a human reply."
                          : "AI is handling this conversation. Take over to reply."}
                  </p>
                ) : null}
                {send.error ? (
                  <Notice variant="error">{send.error.message}</Notice>
                ) : null}
                {approve.error ? (
                  <Notice variant="error">
                    Approval could not be completed: {approve.error.message}
                  </Notice>
                ) : null}
                {rateResponse.error ? (
                  <Notice variant="error">
                    Feedback could not be saved: {rateResponse.error.message}
                  </Notice>
                ) : null}
              </div>
            }
          />
        </TabsContent>
        <TabsContent
          value="notes"
          className="min-h-0 flex-1 overflow-y-auto p-4"
        >
          <div className="space-y-6">
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-xs text-foreground-muted">
                <LockKeyhole aria-hidden="true" className="size-3.5 shrink-0" />
                <p>Only your team can see these notes.</p>
              </div>
              <form
                className="space-y-3"
                onSubmit={(event) => void submitNote(event)}
              >
                <Textarea
                  rows={4}
                  aria-label="Internal note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Share context or leave a handoff for your team…"
                  maxLength={16_000}
                  disabled={addNote.isPending}
                />
                <p className="text-xs text-foreground-muted">
                  Mention a teammate with @email to add this ticket to their
                  Mentions.
                </p>
                <div className="flex justify-end">
                  <Button
                    type="submit"
                    size="sm"
                    loading={addNote.isPending}
                    disabled={!note.trim()}
                  >
                    Add note
                  </Button>
                </div>
              </form>
              {addNote.error ? (
                <Notice variant="error">{addNote.error.message}</Notice>
              ) : null}
            </div>
            {notes.error ? (
              <Notice variant="error">
                Notes could not be loaded: {notes.error.message}
              </Notice>
            ) : notes.isLoading ? (
              <div
                role="status"
                className="flex items-center gap-2 py-4 text-sm text-foreground-muted"
              >
                <LoaderCircle
                  aria-hidden="true"
                  className="size-4 animate-spin"
                />
                Loading notes…
              </div>
            ) : activeTicket.notes?.length ? (
              <ol
                aria-label="Internal notes"
                className="space-y-5 border-t border-border pt-5"
              >
                {activeTicket.notes.map((item, index) => {
                  const authorName = item.authorName?.trim() || "Teammate"
                  return (
                    <li
                      key={item.id ?? index}
                      className="flex items-start gap-3"
                    >
                      <UserAvatarImage
                        name={authorName}
                        image={item.authorImage ?? null}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-h-7 flex-wrap items-baseline gap-x-2 gap-y-1">
                          <span className="text-sm font-medium break-words">
                            {authorName}
                          </span>
                          {item.createdAt ? (
                            <time
                              dateTime={item.createdAt}
                              title={formatDate(item.createdAt)}
                              className="text-xs text-foreground-muted"
                            >
                              {formatRelative(item.createdAt)}
                            </time>
                          ) : null}
                        </div>
                        <p className="mt-1 text-sm leading-relaxed break-words whitespace-pre-wrap">
                          {item.body}
                        </p>
                      </div>
                    </li>
                  )
                })}
              </ol>
            ) : (
              <div className="border-t border-border py-8 text-center">
                <p className="text-sm font-medium">No notes yet</p>
                <p className="mt-1 text-xs text-foreground-muted">
                  Keep useful context here for the next teammate.
                </p>
              </div>
            )}
          </div>
        </TabsContent>
        <TabsContent
          value="details"
          className="min-h-0 flex-1 overflow-y-auto px-4 pb-4"
        >
          <InspectorSection label="Assignment">
            {ticketId ? (
              <TicketAssignment
                ticket={{
                  ...activeTicket,
                  id: ticketId,
                  version: ticketVersion,
                  teamId: activeTicket.teamId ?? null,
                  assigneeUserId: activeTicket.assigneeUserId ?? null,
                }}
                onChanged={refreshInspector}
              />
            ) : null}
          </InspectorSection>
          {macros.error || activeTicket.macros?.length ? (
            <InspectorSection label="Saved replies">
              {macros.error ? (
                <Notice variant="error">
                  Macros could not be loaded: {macros.error.message}
                </Notice>
              ) : activeTicket.macros?.some(
                  (item) => item.enabled !== false
                ) ? (
                <div className="space-y-2">
                  {activeTicket.macros
                    .filter((item) => item.enabled !== false)
                    .map((item) => (
                      <div
                        key={item.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs"
                      >
                        <span className="min-w-0 truncate font-medium">
                          {item.name}
                        </span>
                        <div className="flex shrink-0 flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setMessage((current) =>
                                current ? `${current}\n${item.body}` : item.body
                              )
                              setActiveTab("conversation")
                            }}
                          >
                            Use reply
                          </Button>
                          {item.actions?.length ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              loading={applyMacroAction.isPending}
                              disabled={
                                applyMacroAction.isPending ||
                                typeof ticketVersion !== "number" ||
                                !Number.isInteger(ticketVersion) ||
                                ticketVersion < 1
                              }
                              onClick={() => void applyMacro(item)}
                            >
                              Apply actions
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ))}
                </div>
              ) : (
                <p className="text-xs text-foreground-muted">
                  No enabled saved replies are available.
                </p>
              )}
              {applyMacroAction.error ? (
                <Notice className="mt-2" variant="error">
                  Macro actions could not be applied:{" "}
                  {applyMacroAction.error.message}
                </Notice>
              ) : null}
            </InspectorSection>
          ) : null}
        </TabsContent>
      </Tabs>
    </aside>
  )
}
