"use client"

import * as React from "react"
import {
  requestShopifyCart,
  shopifyCartCommandSchema,
  shopifyCartCleanupSchema,
} from "@/src/lib/build/shopify-cart"
import { requestHostSession } from "@/src/lib/build/chat-host-session"
import { usePublicChallenge } from "./use-public-challenge"
import Image from "next/image"
import datoolLogo from "@/app/icon.svg"
import {
  ArrowDown,
  MessageCircle,
  MessageCircleWarning,
  RefreshCw,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import { cn } from "@/lib/utils"
import {
  HelpPageSidebar,
  HelpPageToolbar,
  HelpPageWelcome,
  HelpPageLinks,
} from "./help-page-layout"
import { AgentAvatar } from "@/components/ui/agent-avatar"
import { ChatTextTranscript } from "@/components/ui/chat-text-transcript"
import {
  chatBubbleSettingsSchema,
  type ChatBubbleSettings,
} from "@/src/lib/build/chat-bubble"
import { bubbleStyle } from "./bubble-style"
import { localizeBubble } from "@/src/lib/build/bubble-localization"
import { buildApi } from "@/components/build/operations/build-api"
import {
  isPublicReplyPending,
  type PublicChatThread,
} from "@/src/lib/build/public-chat"
import {
  ChatComposer,
  ChatTypingIndicator,
} from "@/components/ui/chat-composer"
import { ChatDeliveryStatus } from "@/components/ui/chat-delivery-status"
import { ChatFeedback } from "@/components/ui/chat-feedback"
import { formatRelative } from "@/components/tracer/format"
import { ChatNavigationContext } from "@/components/ui/chat-navigation-context"
import { isSafeHttpUrl } from "@/src/lib/build/urls"

const loadTranscript = () =>
  import("@/components/ui/message-transcript").then((module) => ({
    default: module.MessageTranscript,
  }))
const MessageTranscript = React.lazy(loadTranscript)

type Appearance = ChatBubbleSettings

type Session = {
  conversationId: string
  visitorToken: string
  visitorId: string
  context?: Record<string, unknown>
  appearance?: Partial<Appearance>
}

type ChatMessage = {
  id: string
  direction?: string
  status?: string
  pendingReply?: boolean
  providerMessageId?: string | null
  localSend?: {
    key: string
    conversationId: string
    visitorId: string
    failed: boolean
  }
  text?: string
  attachments?: Array<{
    type?: string
    url?: string
    name?: string
    caption?: string
  }>
  metadata?: Record<string, unknown>
  createdAt?: string
}

const defaultAppearance = chatBubbleSettingsSchema.parse({})
const defaultContext: Record<string, unknown> = {}

function mergeAppearance(value?: Partial<Appearance>): Appearance {
  return chatBubbleSettingsSchema.parse({ ...defaultAppearance, ...value })
}

async function requestJson<T>(
  url: string,
  init?: RequestInit,
  challenge?: (value: {
    siteKey: string
    connectionId: string
  }) => Promise<string>
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    credentials: "include",
  })
  const payload = (await response.json().catch(() => ({}))) as {
    data?: T
    error?: {
      message?: string
      code?: string
      siteKey?: string
      connectionId?: string
    }
  }
  if (
    payload.error?.code === "PUBLIC_CHALLENGE_REQUIRED" &&
    challenge &&
    payload.error.siteKey &&
    payload.error.connectionId
  ) {
    const token = await challenge({
      siteKey: payload.error.siteKey,
      connectionId: payload.error.connectionId,
    })
    return requestJson<T>(url, {
      ...init,
      body: JSON.stringify({
        ...JSON.parse(String(init?.body || "{}")),
        challengeToken: token,
      }),
    })
  }
  if (!response.ok || payload.error)
    throw new Error(
      payload.error?.message ?? `Chat request failed (${response.status})`
    )
  return payload.data as T
}

function sessionKey(channelId: string, origin?: string) {
  return `datool:public-chat:${channelId}:${origin ?? "same-origin"}:session`
}

export function PublicChat({
  channelId,
  embedded = false,
  preloaded = false,
  shopifyIdentity = false,
  context = defaultContext,
  embedOrigin,
  previewAgentId,
  appearanceOverride,
  initialAppearance,
  onBeforeSend,
  onClose,
}: {
  channelId: string
  embedded?: boolean
  preloaded?: boolean
  shopifyIdentity?: boolean
  context?: Record<string, unknown>
  embedOrigin?: string
  previewAgentId?: string
  appearanceOverride?: Appearance
  initialAppearance?: Appearance
  onBeforeSend?: () => Promise<void>
  onClose?: () => void
}) {
  const { verify: verifyChallenge, element: challengeElement } =
    usePublicChallenge()
  const managedEmbed = embedded && preloaded && !previewAgentId
  const [frameVisible, setFrameVisible] = React.useState(!managedEmbed)
  const frameVisibleRef = React.useRef(!managedEmbed)
  const [session, setSession] = React.useState<Session | null>(null)
  const [storedAppearance, setAppearance] = React.useState(
    initialAppearance ?? defaultAppearance
  )
  const { appearance, copy, language } = localizeBubble(
    appearanceOverride ?? storedAppearance,
    typeof navigator === "undefined" ? "en" : navigator.languages.join(",")
  )
  const helpPage = appearance.layout === "help_page"
  const [visitorTheme, setVisitorTheme] = React.useState<
    "light" | "dark" | null
  >(null)
  const theme =
    helpPage && appearance.helpPage.allowThemeSwitch
      ? (visitorTheme ?? appearance.theme)
      : appearance.theme
  const [threads, setThreads] = React.useState<PublicChatThread[]>([])
  const [historyError, setHistoryError] = React.useState<string | null>(null)
  const activeConversationId = React.useRef<string | null>(null)
  const sessionRef = React.useRef<Session | null>(null)
  const readSequence = React.useRef(0)
  const sessionSequence = React.useRef(0)
  const sendingRef = React.useRef(false)
  const cartCleanupAttempts = React.useRef(new Set<string>())
  const [cartCleanupWarningFor, setCartCleanupWarningFor] = React.useState<
    string | null
  >(null)
  const [messages, setMessages] = React.useState<ChatMessage[]>([])
  const [draft, setDraft] = React.useState("")
  const draftRef = React.useRef("")
  const updateDraft = React.useCallback(
    (value: string) => {
      draftRef.current = value
      setDraft(value)
      const active = sessionRef.current
      if (!active || previewAgentId) return
      try {
        window.sessionStorage.setItem(
          `${sessionKey(channelId, embedOrigin)}:draft:${active.conversationId}`,
          value
        )
      } catch {
        /* Chat remains available without browser storage. */
      }
    },
    [channelId, embedOrigin, previewAgentId]
  )
  const linkNavigation = React.useMemo(
    () => ({
      origin: embedded && !previewAgentId ? embedOrigin : undefined,
      navigate(href: string) {
        if (!embedded || previewAgentId || !embedOrigin || !isSafeHttpUrl(href))
          return false
        if (new URL(href).origin !== embedOrigin) return false
        // The host validates this frame's source, origin and destination again.
        window.parent.postMessage(
          { type: "datool:chat:navigate", href },
          embedOrigin
        )
        return true
      },
    }),
    [embedded, previewAgentId, embedOrigin]
  )
  const [loading, setLoading] = React.useState(true)
  const [sending, setSending] = React.useState(false)
  const [feedback, setFeedback] = React.useState<
    Record<string, "positive" | "negative" | undefined>
  >({})
  const [feedbackPending, setFeedbackPending] = React.useState<
    Record<string, boolean>
  >({})
  const [error, setError] = React.useState<string | null>(null)
  const [feedbackError, setFeedbackError] = React.useState<
    Record<string, string | undefined>
  >({})
  const messageLogRef = React.useRef<HTMLDivElement | null>(null)
  const followLatest = React.useRef(true)
  const [hasNewMessage, setHasNewMessage] = React.useState(false)
  const previewConversationKey = React.useRef(crypto.randomUUID())
  const waitingReply =
    sending ||
    isPublicReplyPending(
      messages.filter((message) => !message.localSend?.failed)
    )
  // Delivery receipts change storage IDs, not the identity of a visible bubble.
  const messageKeys = new Map(
    messages.map((message) => {
      if (message.direction !== "inbound") return [message.id, message.id]
      const clientKey =
        message.localSend?.key ?? message.metadata?.clientMessageId
      const receipt =
        message.providerMessageId ??
        (typeof clientKey === "string"
          ? `${session?.visitorId}:${clientKey}`
          : message.id)
      return [message.id, `${message.direction}:${receipt}`]
    })
  )
  const currentTitle =
    threads.find((thread) => thread.id === session?.conversationId)?.title ??
    messages
      .find((message) => message.direction === "inbound")
      ?.text?.slice(0, 120) ??
    copy.newChatShort
  const unavailable = !loading && !!error && !messages.length && !session
  const hasTimestamps = messages.some((message) => !!message.createdAt)
  const [, refreshRelativeTime] = React.useReducer(
    (tick: number) => tick + 1,
    0
  )

  React.useEffect(() => {
    if (!hasTimestamps) return
    const timer = window.setInterval(refreshRelativeTime, 30_000)
    return () => window.clearInterval(timer)
  }, [hasTimestamps])

  const loadHistory = React.useCallback(
    async (active: Session) => {
      if (previewAgentId) return
      try {
        const items = await requestJson<PublicChatThread[]>(
          `/api/build-public/${encodeURIComponent(channelId)}/session`,
          {
            headers: { "x-datool-visitor-token": active.visitorToken },
          }
        )
        if (activeConversationId.current !== active.conversationId) return
        setThreads(items)
        setHistoryError(null)
      } catch {
        if (activeConversationId.current === active.conversationId)
          setHistoryError("Could not load previous conversations.")
      }
    },
    [channelId, previewAgentId]
  )

  const loadConversation = React.useCallback(
    async (active: Session, signal?: AbortSignal) => {
      const sequence = ++readSequence.current
      let incoming: ChatMessage[]
      if (previewAgentId) {
        const result = await buildApi.call<{
          items: Array<{
            id: string
            role: string
            content:
              string | Record<string, unknown> | Array<Record<string, unknown>>
            metadata?: Record<string, unknown>
            createdAt?: string
          }>
        }>(
          "build_list_conversation_messages",
          { conversationId: active.conversationId, limit: 200 },
          signal
        )
        incoming = result.items
          .filter(
            (message) => message.role === "user" || message.role === "assistant"
          )
          .map((message) => ({
            id: message.id,
            direction: message.role === "user" ? "inbound" : "outbound",
            text:
              typeof message.content === "string"
                ? message.content
                : Array.isArray(message.content)
                  ? message.content
                      .map((part) =>
                        typeof part.text === "string" ? part.text : ""
                      )
                      .filter(Boolean)
                      .join("\n")
                  : "",
            metadata: {
              ...(typeof message.content === "object" &&
              !Array.isArray(message.content)
                ? message.content
                : {}),
              ...message.metadata,
            },
            createdAt: message.createdAt,
          }))
      } else {
        incoming = await requestJson<ChatMessage[]>(
          `/api/build-public/${encodeURIComponent(channelId)}/conversation/${encodeURIComponent(active.conversationId)}`,
          {
            signal,
            headers: {
              "x-datool-visitor-token": active.visitorToken,
              ...(embedOrigin ? { "x-datool-embed-origin": embedOrigin } : {}),
            },
          }
        )
      }
      if (
        signal?.aborted ||
        sequence !== readSequence.current ||
        (shopifyIdentity && document.visibilityState === "hidden") ||
        activeConversationId.current !== active.conversationId
      )
        return
      setMessages((current) => [
        ...incoming,
        ...current.filter((message) => {
          const local = message.localSend
          return (
            local?.failed &&
            local.conversationId === active.conversationId &&
            local.visitorId === active.visitorId &&
            !incoming.some(
              (saved) =>
                saved.direction === "inbound" &&
                (saved.providerMessageId ===
                  `${active.visitorId}:${local.key}` ||
                  saved.metadata?.clientMessageId === local.key)
            )
          )
        }),
      ])
      const first = incoming.find((message) => message.direction === "inbound")
      if (first?.text) {
        const thread = {
          id: active.conversationId,
          title: first.text.replace(/\s+/g, " ").slice(0, 120),
          updatedAt: incoming.at(-1)?.createdAt ?? new Date().toISOString(),
        }
        setThreads((current) =>
          [thread, ...current.filter((item) => item.id !== thread.id)].sort(
            (a, b) => b.updatedAt.localeCompare(a.updatedAt)
          )
        )
      }
    },
    [channelId, embedOrigin, previewAgentId, shopifyIdentity]
  )

  const startSession = React.useCallback(
    async (reset = false, threadId?: string) => {
      // Focus and visibility can change when clicking the composer. Never
      // restart a connection or overwrite its optimistic turn during a send.
      if (sendingRef.current) return
      const sequence = ++sessionSequence.current
      ++readSequence.current
      if (!sessionRef.current || reset || threadId) setLoading(true)
      setError(null)
      setFeedback({})
      setFeedbackError({})
      try {
        const key = sessionKey(channelId, embedOrigin)
        if (previewAgentId) {
          if (!sessionRef.current) {
            try {
              const saved = JSON.parse(
                window.sessionStorage.getItem(
                  `${key}:preview-history:${previewAgentId}`
                ) ?? "[]"
              )
              if (Array.isArray(saved))
                setThreads(
                  saved.filter(
                    (item) =>
                      typeof item.id === "string" &&
                      typeof item.title === "string" &&
                      typeof item.updatedAt === "string"
                  )
                )
            } catch {
              /* Storage is optional for previews. */
            }
          }
          if (reset) previewConversationKey.current = crypto.randomUUID()
          const conversation = threadId
            ? { id: threadId }
            : await buildApi.call<{ id: string }>("build_create_conversation", {
                agentId: previewAgentId,
                channel: "web",
                externalConversationId: `bubble-preview:${channelId}:${previewConversationKey.current}`,
                metadata: {
                  source: "channel-preview",
                  connectionId: channelId,
                },
              })
          const active = {
            conversationId: conversation.id,
            visitorToken: "",
            visitorId: "",
            context,
          }
          activeConversationId.current = active.conversationId
          sessionRef.current = active
          setSession(active)
          await loadConversation(active)
          return
        }
        let stored = sessionRef.current
        let active: Session
        let newConversation = false
        if (embedded && embedOrigin && shopifyIdentity) {
          let result = await requestHostSession<Session>(embedOrigin, {
            newConversation: reset,
            conversationId: threadId ?? stored?.conversationId,
          })
          if (
            result.error?.code === "PUBLIC_CHALLENGE_REQUIRED" &&
            result.error.siteKey &&
            result.error.connectionId
          ) {
            const challengeToken = await verifyChallenge({
              siteKey: result.error.siteKey,
              connectionId: result.error.connectionId,
            })
            result = await requestHostSession<Session>(embedOrigin, {
              newConversation: reset,
              conversationId: threadId,
              challengeToken,
            })
          }
          if (result.error || !result.shopify || !result.session)
            throw new Error(
              result.error?.message || "Could not verify your store session."
            )
          if (sequence !== sessionSequence.current) return
          active = result.session
          if (stored && stored.visitorId !== active.visitorId) {
            ++readSequence.current
            setMessages([])
            setThreads([])
            setDraft("")
            setFeedback({})
          }
        } else {
          if (!stored && embedded && embedOrigin) {
            try {
              stored =
                (await requestHostSession<Session>(embedOrigin)).session ?? null
            } catch {
              /* Older embed hosts use iframe storage. */
            }
          }
          if (!stored) {
            try {
              const value =
                window.localStorage.getItem(key) ??
                window.sessionStorage.getItem(key)
              stored = value ? (JSON.parse(value) as Session) : null
            } catch {
              stored = null
            }
          }
          if (
            typeof stored?.visitorToken !== "string" ||
            typeof stored?.conversationId !== "string"
          )
            stored = null
          if (stored) {
            try {
              const payload = JSON.parse(
                atob(
                  stored.visitorToken
                    .split(".")[0]
                    .replace(/-/g, "+")
                    .replace(/_/g, "/")
                )
              )
              if (payload.expiresAt <= Date.now() / 1000) stored = null
            } catch {
              stored = null
            }
          }
          newConversation = !threadId && (reset || !stored)
          active = await requestJson<Session>(
            `/api/build-public/${encodeURIComponent(channelId)}/session`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                context,
                visitorToken: stored?.visitorToken,
                conversationId:
                  threadId ?? (!reset ? stored?.conversationId : undefined),
              }),
            },
            verifyChallenge
          )
          try {
            window.localStorage.setItem(key, JSON.stringify(active))
            window.sessionStorage.setItem(key, JSON.stringify(active))
          } catch {
            /* Optional storage. */
          }
          if (embedded && embedOrigin)
            window.parent.postMessage(
              { type: "datool:chat:session-save", session: active },
              embedOrigin
            )
        }
        if (sequence !== sessionSequence.current) return
        activeConversationId.current = active.conversationId
        sessionRef.current = active
        setSession(active)
        try {
          const savedDraft =
            window.sessionStorage.getItem(
              `${key}:draft:${active.conversationId}`
            ) ?? ""
          const switched =
            stored &&
            (stored.conversationId !== active.conversationId ||
              stored.visitorId !== active.visitorId)
          setDraft((current) => (switched ? savedDraft : current || savedDraft))
        } catch {
          /* Preserve text typed while the session was connecting. */
        }
        // Both public and Shopify session responses already include appearance.
        // Shopify may resume a thread, so only known-new public chats skip history.
        if (active.appearance) setAppearance(mergeAppearance(active.appearance))
        if (newConversation) setMessages([])
        await Promise.all([
          active.appearance
            ? Promise.resolve()
            : requestJson<{ appearance: Appearance }>(
                `/api/build-public/${encodeURIComponent(channelId)}/appearance`
              ).then((result) => {
                if (sequence === sessionSequence.current)
                  setAppearance(mergeAppearance(result.appearance))
              }),
          newConversation ? Promise.resolve() : loadConversation(active),
        ])
        if (sequence !== sessionSequence.current) return
        if (helpPage) void loadHistory(active)
      } catch (reason) {
        if (sequence !== sessionSequence.current) return
        if (shopifyIdentity) {
          ++readSequence.current
          setMessages([])
          setSession(null)
          sessionRef.current = null
        }
        setError(
          reason instanceof Error
            ? reason.message
            : "This chat could not be loaded."
        )
      } finally {
        if (sequence === sessionSequence.current) setLoading(false)
      }
    },
    [
      channelId,
      context,
      embedOrigin,
      helpPage,
      loadConversation,
      loadHistory,
      previewAgentId,
      embedded,
      shopifyIdentity,
      verifyChallenge,
    ]
  )

  React.useEffect(() => {
    if (
      !shopifyIdentity ||
      previewAgentId ||
      !embedOrigin ||
      !session ||
      loading
    )
      return
    const current = () =>
      sessionRef.current?.visitorId === session.visitorId &&
      sessionRef.current?.conversationId === session.conversationId
    for (const message of messages) {
      if (
        message.direction !== "outbound" ||
        !["sent", "delivered"].includes(message.status ?? "")
      )
        continue
      const parsed = shopifyCartCleanupSchema.safeParse(
        message.metadata?.shopifyCartCleanup
      )
      if (!parsed.success || parsed.data.expiresAt <= Date.now()) continue
      const cleanup = parsed.data
      const key = `${session.visitorId}:${cleanup.operationId}`
      if (cartCleanupAttempts.current.has(key)) continue
      cartCleanupAttempts.current.add(key)
      void (async () => {
        // Reverify through Shopify before an automatic browser write, just as
        // interactive cart changes do. A payment event cannot select a cart.
        const verified = await requestHostSession<Session>(embedOrigin, {
          conversationId: session.conversationId,
        })
        if (!current()) return
        if (
          verified.error ||
          verified.session?.visitorId !== session.visitorId ||
          verified.session.conversationId !== session.conversationId
        )
          throw new Error("Store session changed")
        const result = await requestShopifyCart(
          embedOrigin,
          { operation: "complete_order", snapshotId: cleanup.snapshotId },
          cleanup.operationId,
          session.visitorId,
          cleanup.expiresAt
        )
        if (result.status !== "completed")
          throw new Error("Cart cleanup was not confirmed")
      })().catch(() => {
        if (current())
          setCartCleanupWarningFor(
            `${session.visitorId}:${session.conversationId}`
          )
      })
    }
  }, [embedOrigin, loading, messages, previewAgentId, session, shopifyIdentity])

  React.useEffect(() => {
    if (!shopifyIdentity || previewAgentId) return
    const refresh = () => {
      if (document.visibilityState !== "hidden") void startSession()
      else {
        ++sessionSequence.current
        ++readSequence.current
        setMessages([])
        setThreads([])
        setLoading(true)
      }
    }
    const onFocus = () => {
      if (!managedEmbed || frameVisibleRef.current) refresh()
    }
    window.addEventListener("focus", onFocus)
    // A hidden storefront can change accounts in another tab, even when its
    // launcher was closed. Invalidate its private transcript in either state.
    document.addEventListener("visibilitychange", refresh)
    const timer =
      !managedEmbed || frameVisible
        ? window.setInterval(refresh, 60_000)
        : undefined
    return () => {
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", refresh)
      window.clearInterval(timer)
    }
  }, [
    shopifyIdentity,
    previewAgentId,
    startSession,
    managedEmbed,
    frameVisible,
  ])

  React.useEffect(() => {
    if (!previewAgentId || !session) return
    try {
      window.sessionStorage.setItem(
        `${sessionKey(channelId, embedOrigin)}:preview-history:${previewAgentId}`,
        JSON.stringify(threads)
      )
    } catch {
      /* Optional local preview history. */
    }
  }, [channelId, embedOrigin, previewAgentId, session, threads])

  React.useEffect(() => {
    if (!managedEmbed || !embedOrigin || window.parent === window) return
    let parentOrigin: string
    try {
      parentOrigin = new URL(embedOrigin).origin
    } catch {
      return
    }
    const onVisibility = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== parentOrigin)
        return
      if (
        event.data?.type !== "datool:chat:visibility" ||
        typeof event.data.visible !== "boolean"
      )
        return
      const opening = event.data.visible && !frameVisibleRef.current
      frameVisibleRef.current = event.data.visible
      setFrameVisible(event.data.visible)
      // Closing the launcher does not change the store identity. Keep the
      // verified conversation mounted; check again without blanking it on open.
      if (opening && shopifyIdentity && sessionRef.current) void startSession()
    }
    window.addEventListener("message", onVisibility)
    window.parent.postMessage({ type: "datool:chat:ready" }, parentOrigin)
    return () => window.removeEventListener("message", onVisibility)
  }, [managedEmbed, embedOrigin, shopifyIdentity, startSession])

  React.useEffect(() => {
    // Warm the session and transcript with the iframe, before a launcher click.
    void startSession()
    void loadTranscript().catch(() => {
      // A failed preload must not interrupt session warmup.
    })
  }, [startSession])

  React.useEffect(() => {
    if (
      !session ||
      previewAgentId ||
      loading ||
      (managedEmbed && !frameVisible)
    )
      return
    const controller = new AbortController()
    let polling = false
    const timer = window.setInterval(() => {
      if (
        polling ||
        sendingRef.current ||
        loading ||
        document.visibilityState === "hidden"
      )
        return
      polling = true
      void loadConversation(session, controller.signal)
        .catch((reason) => {
          if (controller.signal.aborted) return
          if (shopifyIdentity) {
            setMessages([])
            setThreads([])
            void startSession()
          }
          setError(
            reason instanceof Error
              ? reason.message
              : "The conversation could not be refreshed."
          )
        })
        .finally(() => {
          polling = false
        })
    }, 1_000)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [
    loadConversation,
    session,
    previewAgentId,
    loading,
    shopifyIdentity,
    startSession,
    managedEmbed,
    frameVisible,
  ])

  const scrollToLatest = React.useCallback(() => {
    if (!followLatest.current) return
    const log = messageLogRef.current
    if (!log) return
    const latestMessage = Array.from(
      log.querySelectorAll("[data-chat-message]")
    ).at(-1)
    const widget = latestMessage?.querySelector("[data-slot=chat-widget]")
    // Open an interactive card at its beginning, especially when a form is
    // taller than the chat viewport. Text replies still follow the bottom.
    log.scrollTo({
      top: widget
        ? log.scrollTop +
          widget.getBoundingClientRect().top -
          log.getBoundingClientRect().top -
          16
        : messages.length
          ? log.scrollHeight
          : 0,
      behavior: "instant",
    })
  }, [messages.length])
  const onTranscriptMount = React.useCallback(
    (node: HTMLDivElement | null) => {
      if (node) scrollToLatest()
    },
    [scrollToLatest]
  )
  const lastMessage = messages.findLast((message) => !message.localSend?.failed)
  React.useEffect(() => {
    followLatest.current = true
    setHasNewMessage(false)
    // A different conversation starts at its latest message.
  }, [session?.conversationId])
  React.useEffect(() => {
    if (followLatest.current) scrollToLatest()
    else if (lastMessage?.direction === "outbound") setHasNewMessage(true)
  }, [
    scrollToLatest,
    session?.conversationId,
    lastMessage?.id,
    lastMessage?.text,
    lastMessage?.direction,
    sending,
  ])

  async function submit(
    event?: React.FormEvent,
    suggestedText?: string,
    interaction?: Record<string, unknown>,
    cartRequest?: { command?: unknown; expiresAt?: number },
    retryMessage?: ChatMessage
  ) {
    event?.preventDefault()
    const text = (suggestedText ?? draft).trim()
    if (!text || !session || waitingReply || loading || sendingRef.current)
      return
    if (
      retryMessage &&
      (!retryMessage.localSend?.failed ||
        retryMessage.localSend.conversationId !== session.conversationId ||
        retryMessage.localSend.visitorId !== session.visitorId)
    )
      return
    let activeSession = session
    // Invalidate background session/message reads before showing the local turn.
    ++sessionSequence.current
    sendingRef.current = true
    ++readSequence.current
    if (!interaction && !retryMessage) updateDraft("")
    setError(null)
    setSending(true)
    const requestKey = retryMessage?.localSend?.key ?? crypto.randomUUID()
    const localMessageId = retryMessage?.id ?? `local-${requestKey}`
    followLatest.current = true
    setHasNewMessage(false)
    const optimistic: ChatMessage = {
      id: localMessageId,
      direction: "inbound",
      status: "queued",
      pendingReply: true,
      text,
      metadata: {
        clientMessageId: requestKey,
        ...(interaction ? { widgetInteraction: interaction } : {}),
      },
      ...(!interaction
        ? {
            localSend: {
              key: requestKey,
              conversationId: activeSession.conversationId,
              visitorId: activeSession.visitorId,
              failed: false,
            },
          }
        : {}),
    }
    setMessages((current) =>
      retryMessage
        ? current.map((message) =>
            message.id === localMessageId ? optimistic : message
          )
        : [...current, optimistic]
    )
    const undoOptimistic = () => {
      setMessages((current) =>
        current.filter((message) => message.id !== localMessageId)
      )
      if (!suggestedText && !interaction && !draftRef.current) updateDraft(text)
      sendingRef.current = false
      setSending(false)
    }
    if (shopifyIdentity && embedOrigin) {
      const verificationSequence = sessionSequence.current
      try {
        const result = await requestHostSession<Session>(embedOrigin, {
          conversationId: activeSession.conversationId,
        })
        if (result.error || !result.session)
          throw new Error(
            result.error?.message || "Could not verify your store session."
          )
        if (
          verificationSequence !== sessionSequence.current ||
          result.session.visitorId !== activeSession.visitorId ||
          result.session.conversationId !== activeSession.conversationId
        ) {
          undoOptimistic()
          setMessages([])
          setThreads([])
          setLoading(true)
          await startSession()
          if (!interaction) updateDraft(draftRef.current || text)
          setError(
            "Your store session changed. Please review the chat before sending."
          )
          return
        }
        activeSession = result.session
        sessionRef.current = activeSession
        setSession(activeSession)
      } catch {
        undoOptimistic()
        setMessages([])
        setThreads([])
        sessionRef.current = null
        setSession(null)
        setError(
          "Could not verify your store session. Please refresh the page."
        )
        return
      }
    }
    if (cartRequest) {
      try {
        if (
          !shopifyIdentity ||
          !embedOrigin ||
          typeof interaction?.continuationId !== "string" ||
          typeof cartRequest.expiresAt !== "number"
        )
          throw new Error(
            "Open this chat on the Shopify store to use its cart."
          )
        const cartResult = await requestShopifyCart(
          embedOrigin,
          shopifyCartCommandSchema.parse(cartRequest.command),
          interaction.continuationId,
          activeSession.visitorId,
          cartRequest.expiresAt
        )
        interaction = { ...interaction, input: { cartResult } }
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not access your cart."
        )
        undoOptimistic()
        return
      }
    }
    if (!messages.some((message) => message.direction === "inbound")) {
      setThreads((current) => [
        {
          id: activeSession.conversationId,
          title: text.replace(/\s+/g, " ").slice(0, 120),
          updatedAt: new Date().toISOString(),
        },
        ...current.filter(
          (thread) => thread.id !== activeSession.conversationId
        ),
      ])
    }
    try {
      const messageContext = { ...activeSession.context, ...context }
      if (previewAgentId) {
        await onBeforeSend?.()
        await buildApi.call(
          "build_run_agent_turn",
          {
            agentId: previewAgentId,
            channel: "web",
            conversationId: activeSession.conversationId,
            message: text,
            metadata: {
              source: "channel-preview",
              clientMessageId: requestKey,
              context: messageContext,
              ...(interaction ? { widgetInteraction: interaction } : {}),
            },
          },
          { idempotencyKey: requestKey }
        )
      } else {
        await requestJson(
          `/api/build-public/${encodeURIComponent(channelId)}/conversation/${encodeURIComponent(activeSession.conversationId)}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-datool-visitor-token": activeSession.visitorToken,
              ...(embedOrigin ? { "x-datool-embed-origin": embedOrigin } : {}),
            },
            body: JSON.stringify({
              text,
              idempotencyKey: requestKey,
              metadata: {
                context: messageContext,
                ...(interaction ? { widgetInteraction: interaction } : {}),
              },
            }),
          }
        )
      }
    } catch (reason) {
      if (interaction) {
        undoOptimistic()
        setError(
          reason instanceof Error
            ? reason.message
            : "Your message could not be sent."
        )
      } else {
        // A missing acknowledgement can mean the server accepted the message.
        // Keep its key for retries; history reconciles it by the provider ID.
        setMessages((current) =>
          current.map((message) =>
            message.id === localMessageId && message.localSend
              ? {
                  ...message,
                  pendingReply: false,
                  localSend: { ...message.localSend, failed: true },
                }
              : message
          )
        )
        sendingRef.current = false
        setSending(false)
      }
      return
    }
    try {
      await loadConversation(activeSession)
    } catch (reason) {
      setMessages((current) =>
        current.map((message) =>
          message.id === localMessageId
            ? { ...message, status: "sent" }
            : message
        )
      )
      setError(
        reason instanceof Error
          ? `Message sent, but the conversation could not be refreshed: ${reason.message}`
          : "Message sent, but the conversation could not be refreshed. It will retry automatically."
      )
    }
    sendingRef.current = false
    setSending(false)
  }

  async function sendFeedback(
    messageId: string,
    sentiment: "positive" | "negative"
  ) {
    if (
      !session ||
      feedbackPending[messageId] ||
      feedback[messageId] === sentiment
    )
      return
    const messageIndex = messages.findIndex(
      (message) => message.id === messageId
    )
    if (messageIndex < 0 || messages[messageIndex]?.direction !== "outbound")
      return
    const previous = feedback[messageId]
    setFeedback((current) => ({ ...current, [messageId]: sentiment }))
    setFeedbackPending((current) => ({ ...current, [messageId]: true }))
    setFeedbackError((current) => ({ ...current, [messageId]: undefined }))
    const question =
      messages
        .slice(0, messageIndex)
        .reverse()
        .find((item) => item.direction === "inbound")?.text ??
      "Conversation response"
    try {
      if (previewAgentId) {
        await buildApi.call("build_record_feedback", {
          conversationId: session.conversationId,
          messageId,
          question: question.slice(0, 4_000),
          sentiment,
          channel: "web",
          metadata: { source: "channel-preview", messageId },
        })
        return
      }
      await requestJson(
        `/api/build-public/${encodeURIComponent(channelId)}/feedback`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-datool-visitor-token": session.visitorToken,
            ...(embedOrigin ? { "x-datool-embed-origin": embedOrigin } : {}),
          },
          body: JSON.stringify({
            conversationId: session.conversationId,
            visitorToken: session.visitorToken,
            messageId,
            question: question.slice(0, 4_000),
            sentiment,
          }),
        }
      )
    } catch (reason) {
      setFeedback((current) => ({ ...current, [messageId]: previous }))
      setFeedbackError((current) => ({
        ...current,
        [messageId]:
          reason instanceof Error
            ? reason.message
            : "Feedback could not be recorded.",
      }))
    } finally {
      setFeedbackPending((current) => ({ ...current, [messageId]: false }))
    }
  }

  async function resetConversation() {
    if (!session) return
    if (previewAgentId || helpPage) {
      setMessages([])
      setDraft("")
      setFeedback({})
      setFeedbackError({})
      await startSession(true)
      return
    }

    setError(null)
    try {
      await requestJson(
        `/api/build-public/${encodeURIComponent(channelId)}/conversation/${encodeURIComponent(session.conversationId)}`,
        {
          method: "DELETE",
          headers: { "x-datool-visitor-token": session.visitorToken },
        }
      )
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The conversation could not be reset."
      )
      return
    }
    updateDraft("")
    try {
      window.sessionStorage.removeItem(sessionKey(channelId, embedOrigin))
    } catch {
      /* Optional storage. */
    }
    setMessages([])
    setFeedback({})
    setFeedbackError({})
    await startSession(true)
  }

  async function openThread(id: string) {
    if (id === session?.conversationId || loading || sending) return
    setDraft("")
    setMessages([])
    activeConversationId.current = id
    setSession((current) =>
      current ? { ...current, conversationId: id } : current
    )
    await startSession(false, id)
  }

  const navigation = {
    settings: appearance,
    threads,
    activeThreadId: session?.conversationId,
    title: currentTitle,
    historyLabel: copy.conversations,
    historyEmpty: copy.noConversations,
    historyError,
    onSelectThread: (id: string) => void openThread(id),
    newChatLabel: copy.newChatShort,
    disabled: loading || sending || !session,
    onNewChat: () => void resetConversation(),
    theme,
    onThemeChange: () => setVisitorTheme(theme === "light" ? "dark" : "light"),
  }
  const messageDelivery = (id: string) => {
    const message = messages.find((item) => item.id === id)
    if (!message?.localSend?.failed) return null
    return (
      <ChatDeliveryStatus
        label={copy.notSent}
        retryLabel={copy.retryMessage}
        disabled={waitingReply || loading || !session}
        onRetry={() =>
          void submit(undefined, message.text, undefined, undefined, message)
        }
      />
    )
  }
  const composer = (
    <footer
      hidden={unavailable}
      className={cn(
        "shrink-0 bg-background p-4 pb-[max(1rem,env(safe-area-inset-bottom))]",
        helpPage && "mx-auto w-full max-w-3xl bg-transparent",
        helpPage && !messages.length && "p-0 pb-0"
      )}
    >
      {session &&
      cartCleanupWarningFor ===
        `${session.visitorId}:${session.conversationId}` ? (
        <Notice variant="warning" role="status" className="mb-3 text-xs">
          <div className="flex items-start justify-between gap-3">
            <p>
              Your order is placed, but the cart update could not be confirmed.
              Check your cart before checking out again.
            </p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setCartCleanupWarningFor(null)}
            >
              Dismiss
            </Button>
          </div>
        </Notice>
      ) : null}
      {error && !unavailable ? (
        <div
          className="mb-3 flex items-start justify-between gap-3 rounded-md border border-destructive-border bg-destructive-background px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          <p>{error}</p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="-my-1 -mr-1"
            onClick={() => {
              if (!session) return
              void loadConversation(session)
                .then(() => setError(null))
                .catch((reason) =>
                  setError(
                    reason instanceof Error
                      ? reason.message
                      : "The conversation could not be refreshed."
                  )
                )
            }}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {appearance.suggestedReplies.length &&
      !messages.length &&
      !loading &&
      !error ? (
        <div
          className="mb-3 flex flex-wrap gap-2"
          role="group"
          aria-label="Suggested replies"
        >
          {appearance.suggestedReplies.map((reply) => (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 rounded-full text-xs text-foreground-muted"
              key={reply}
              onClick={() => void submit(undefined, reply)}
              disabled={loading || sending || !session}
            >
              {reply}
            </Button>
          ))}
        </div>
      ) : null}
      {appearance.showBranding &&
      !messages.some((message) => message.direction === "inbound") ? (
        <p className="mb-3 flex items-center justify-center gap-1 text-xs text-foreground-muted">
          <span>{copy.branding} </span>
          <a
            href="https://trydatool.com"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-sm px-0.5 py-1 font-medium text-foreground transition-colors outline-none hover:text-foreground-muted focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Image
              src={datoolLogo}
              alt=""
              width={16}
              height={16}
              unoptimized
              className="size-4 shrink-0"
            />
            Datool
          </a>
        </p>
      ) : null}
      <form
        data-help-glow={
          helpPage && appearance.helpPage.fieldGlow && !messages.length
            ? ""
            : undefined
        }
        onSubmit={(event) => void submit(event)}
      >
        <ChatComposer
          variant={helpPage && !messages.length ? "help-page" : "customer"}
          text={draft}
          onTextChange={updateDraft}
          running={waitingReply}
          allowDraftWhileRunning
          disabled={unavailable}
          canSubmit={!!draft.trim() && !waitingReply && !loading && !!session}
          placeholder={appearance.inputPlaceholder}
          messageLabel={copy.message}
          sendLabel={copy.send}
          accentSend={appearance.accentSend}
          maxLength={20_000}
        />
      </form>
    </footer>
  )

  return (
    <ChatNavigationContext.Provider value={linkNavigation}>
      {challengeElement}
      <main
        className={cn(
          "datool-chat-surface flex min-h-0 w-full justify-center bg-background text-foreground",
          previewAgentId ? "h-full" : "h-dvh",
          helpPage && "datool-help-page @container/help"
        )}
        lang={language}
        data-theme={theme}
        style={bubbleStyle(appearance)}
      >
        {helpPage ? <HelpPageSidebar {...navigation} /> : null}
        <section
          aria-label={`${appearance.displayName} chat`}
          className={cn(
            "@container/chat flex min-h-0 w-full min-w-0 flex-col overflow-hidden bg-surface-canvas",
            previewAgentId ? "h-full" : "h-dvh",
            !helpPage && "max-w-2xl",
            !helpPage && !previewAgentId && "border-x border-border shadow-sm"
          )}
        >
          {helpPage ? (
            <HelpPageToolbar {...navigation} />
          ) : (
            <header
              data-bubble-header={
                appearance.accentHeader ? "accent" : undefined
              }
              className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-4 py-3 @min-[28rem]/chat:px-5"
            >
              <div className="flex min-w-0 items-center gap-3">
                <AgentAvatar
                  appearance={appearance}
                  className="size-9 rounded-lg"
                />
                <div className="min-w-0">
                  <h1 className="truncate text-sm font-semibold">
                    {appearance.displayName}
                  </h1>
                  <p className="text-xs opacity-70">{copy.assistant}</p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost-muted"
                  disabled={loading || sending || !session}
                  onClick={() => void resetConversation()}
                  aria-label={copy.newChat}
                  title={copy.newChat}
                >
                  <RefreshCw className="size-4" aria-hidden />
                </Button>
                {embedded ? (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost-muted"
                    onClick={() =>
                      onClose
                        ? onClose()
                        : window.parent.postMessage(
                            { type: "datool:chat:close" },
                            "*"
                          )
                    }
                    aria-label={copy.close}
                    title={copy.close}
                  >
                    <X className="size-4" aria-hidden />
                  </Button>
                ) : null}
              </div>
            </header>
          )}
          <div
            role="log"
            ref={messageLogRef}
            onScroll={(event) => {
              const log = event.currentTarget
              followLatest.current =
                log.scrollHeight - log.scrollTop - log.clientHeight < 64
              if (followLatest.current) setHasNewMessage(false)
            }}
            tabIndex={0}
            aria-label={`Conversation with ${appearance.displayName}`}
            aria-live="polite"
            aria-busy={loading || waitingReply}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-3 py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset @min-[28rem]/chat:px-5"
          >
            {unavailable ? (
              <div
                role="alert"
                className="m-auto flex max-w-64 flex-col items-center px-3 py-8 text-center"
              >
                <div className="mb-4 flex size-11 items-center justify-center rounded-full bg-muted text-foreground-muted">
                  <MessageCircleWarning className="size-5" aria-hidden />
                </div>
                <h2 className="text-sm font-medium text-foreground">
                  {copy.unavailable}
                </h2>
                <p className="mt-2 text-sm leading-5 text-foreground-muted">
                  {copy.unavailableDescription}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-5"
                  onClick={() => void startSession(true)}
                >
                  <RefreshCw className="size-3.5" aria-hidden />
                  {copy.retry}
                </Button>
              </div>
            ) : null}
            {!helpPage &&
            !error &&
            !messages.length &&
            appearance.welcomeMessage ? (
              <div
                data-bubble-message
                className="mb-4 w-fit max-w-[min(85%,36rem)] bg-muted px-3 py-2.5 text-sm"
              >
                <p className="break-words whitespace-pre-wrap">
                  {appearance.welcomeMessage}
                </p>
              </div>
            ) : null}
            {!helpPage &&
            !error &&
            !messages.length &&
            !appearance.welcomeMessage ? (
              <div className="flex flex-1 flex-col items-center justify-center text-center text-sm text-foreground-muted">
                <MessageCircle className="mb-2 size-5" aria-hidden />
                <p>{copy.start}</p>
              </div>
            ) : null}
            {helpPage && !loading && !error && !messages.length ? (
              <div className="m-auto w-full max-w-3xl px-3 py-10 @min-[700px]/help:px-8">
                <HelpPageWelcome settings={appearance} />
                {composer}
                <HelpPageLinks settings={appearance} />
              </div>
            ) : null}
            {messages.length > 0 || waitingReply ? (
              <React.Suspense
                fallback={
                  <ChatTextTranscript
                    renderMessageFooter={messageDelivery}
                    messages={messages.map((message) => ({
                      id: message.id,
                      text: message.text ?? "",
                      outgoing: message.direction === "inbound",
                    }))}
                    pendingReply={
                      waitingReply ? (
                        <ChatTypingIndicator label={copy.thinking} />
                      ) : undefined
                    }
                  />
                }
              >
                <div
                  ref={onTranscriptMount}
                  className={helpPage ? "mx-auto w-full max-w-3xl" : undefined}
                >
                  <MessageTranscript
                    key={session?.conversationId}
                    getMessageKey={(message) =>
                      messageKeys.get(message.id ?? "")
                    }
                    pendingReply={
                      waitingReply ? (
                        <ChatTypingIndicator label={copy.thinking} />
                      ) : undefined
                    }
                    variant="customer"
                    messages={messages
                      .filter(
                        (message) =>
                          message.text?.trim() ||
                          message.attachments?.length ||
                          !shopifyCartCleanupSchema.safeParse(
                            message.metadata?.shopifyCartCleanup
                          ).success
                      )
                      .map((message) => ({
                        ...message,
                        role:
                          message.direction === "inbound"
                            ? "user"
                            : "assistant",
                        content: message.text ?? "",
                        toolCalls: [],
                      }))}
                    onWidgetInteraction={
                      sending || loading || !session
                        ? undefined
                        : (message, interaction, label) => {
                            const continuations =
                              message.metadata?.continuations
                            const pending = Array.isArray(continuations)
                              ? continuations.find(
                                  (item) =>
                                    item &&
                                    item.continuationId ===
                                      interaction.continuationId &&
                                    item.actionId === interaction.actionId
                                )
                              : undefined
                            void submit(
                              undefined,
                              label,
                              {
                                ...interaction,
                                sourceMessageId: message.id,
                              },
                              pending?.shopifyCart
                            )
                          }
                    }
                    renderMessageFooter={(message) => {
                      if (message.id && message.role === "user")
                        return messageDelivery(message.id)
                      if (message.role !== "assistant" || !message.id)
                        return null
                      const messageId = message.id
                      return (
                        <div className="mt-1 max-w-[85%] px-2 text-xs text-foreground-muted">
                          <div className="flex items-center gap-2">
                            {message.createdAt ? (
                              <time
                                dateTime={message.createdAt}
                                title={new Date(
                                  message.createdAt
                                ).toLocaleString(language)}
                              >
                                {Math.abs(
                                  Date.now() -
                                    new Date(message.createdAt).getTime()
                                ) < 60_000
                                  ? copy.justNow
                                  : formatRelative(message.createdAt, language)}
                              </time>
                            ) : null}
                            {appearance.showFeedback ? (
                              <ChatFeedback
                                value={feedback[messageId]}
                                onChange={(value) =>
                                  void sendFeedback(messageId, value)
                                }
                                disabled={
                                  !session || feedbackPending[messageId]
                                }
                                label={copy.feedback}
                                positiveLabel={copy.helpful}
                                negativeLabel={copy.notHelpful}
                                hideLabel
                              />
                            ) : null}
                          </div>
                          {feedbackError[messageId] ? (
                            <p className="mt-1 text-destructive" role="alert">
                              {feedbackError[messageId]}
                            </p>
                          ) : null}
                        </div>
                      )
                    }}
                  />
                </div>
              </React.Suspense>
            ) : null}
            <div className="min-h-1" aria-hidden />
          </div>
          {hasNewMessage ? (
            <div className="flex shrink-0 justify-center py-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  followLatest.current = true
                  setHasNewMessage(false)
                  scrollToLatest()
                }}
              >
                {copy.newMessage}
                <ArrowDown className="size-3.5" aria-hidden />
              </Button>
            </div>
          ) : null}
          {!helpPage || messages.length > 0 ? composer : null}
        </section>
      </main>
    </ChatNavigationContext.Provider>
  )
}
