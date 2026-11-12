"use client"

import * as React from "react"
import type {
  ChatMessage,
  ChatMessages,
  ChatRequest,
  SendResult,
} from "@datool/sdk/agents"
export type { ChatMessage } from "@datool/sdk/agents"
export type DatoolChatProps = {
  endpoint?: string
  threadId?: string
  title?: string
  welcomeMessage?: string
  placeholder?: string
  className?: string
  style?: React.CSSProperties
  pollingInterval?: number
}

/** Native React chat. All authentication and drive selection happen on your server. */
export function DatoolChat(props: DatoolChatProps) {
  const [attempt, setAttempt] = React.useState(0)
  return (
    <DatoolChatSession
      key={JSON.stringify([props.endpoint, props.threadId, attempt])}
      {...props}
      reconnect={() => setAttempt((value) => value + 1)}
    />
  )
}

function DatoolChatSession({
  endpoint = "/api/datool",
  threadId = "default",
  title = "Assistant",
  welcomeMessage = "How can I help?",
  placeholder = "Message your assistant…",
  className = "",
  style,
  pollingInterval = 3000,
  reconnect,
}: DatoolChatProps & { reconnect: () => void }) {
  const [messages, setMessages] = React.useState<ChatMessage[]>([])
  const [conversationId, setConversationId] = React.useState<string>()
  const [draft, setDraft] = React.useState("")
  const [loading, setLoading] = React.useState(true)
  const [sending, setSending] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [before, setBefore] = React.useState<string | null>(null)
  const [loadingHistory, setLoadingHistory] = React.useState(false)
  const generation = React.useRef(0)
  const retryMessage = React.useRef<{ text: string; requestId: string } | null>(
    null
  )
  const sendingRef = React.useRef(false)
  const log = React.useRef<HTMLDivElement>(null)
  const shouldFollow = React.useRef(true)
  const inputId = React.useId()
  const errorId = React.useId()
  const request = React.useCallback(
    async <T,>(payload: ChatRequest, signal?: AbortSignal): Promise<T> => {
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = (await response.json()) as {
        data: T
        error?: { message?: string }
      }
      if (!response.ok) {
        const failure = new Error(
          body.error?.message ?? "Could not connect. Try again."
        )
        Object.assign(failure, { status: response.status })
        throw failure
      }
      return body.data
    },
    [endpoint]
  )
  const applyMessages = React.useCallback((data: ChatMessages) => {
    setMessages((previous) => {
      const current = new Map(previous.map((message) => [message.id, message]))
      for (const message of data.messages) current.set(message.id, message)
      return [...current.values()]
    })
    setPending(data.pending)
    if (data.failed) {
      retryMessage.current = null
      setError(
        "The assistant could not finish its last reply. You can try another message."
      )
    }
  }, [])
  React.useEffect(() => {
    const current = ++generation.current
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function start() {
      try {
        const session = await request<{ conversationId: string }>(
          { action: "session", threadId },
          controller.signal
        )
        if (current !== generation.current || controller.signal.aborted) return
        setConversationId(session.conversationId)
        let first = true
        const poll = async () => {
          try {
            if (first || (!document.hidden && !sendingRef.current)) {
              const data = await request<ChatMessages>(
                { action: "messages", conversationId: session.conversationId },
                controller.signal
              )
              if (current !== generation.current || controller.signal.aborted)
                return
              if (!data.failed) setError(undefined)
              applyMessages(data)
              if (first) {
                setBefore(data.nextCursor)
                first = false
              }
              setLoading(false)
            }
          } catch (reason) {
            if (controller.signal.aborted) return
            if (
              [401, 403, 404].includes(
                (reason as { status?: number }).status ?? 0
              )
            ) {
              setMessages([])
              setConversationId(undefined)
              setPending(false)
              setError("Your chat session changed. Reconnect to continue.")
              setLoading(false)
              return
            }
            setError(
              reason instanceof Error
                ? reason.message
                : "Could not refresh chat."
            )
            setLoading(false)
          }
          if (!controller.signal.aborted)
            timer = setTimeout(poll, Math.max(1000, pollingInterval))
        }
        await poll()
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(
            reason instanceof Error ? reason.message : "Could not open chat."
          )
          setLoading(false)
        }
      }
    }
    void start()
    return () => {
      generation.current = current + 1
      controller.abort()
      clearTimeout(timer)
    }
  }, [request, threadId, pollingInterval, applyMessages])
  React.useEffect(() => {
    if (shouldFollow.current && log.current)
      log.current.scrollTop = log.current.scrollHeight
  }, [messages, pending])

  async function send(event: React.FormEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (!conversationId || !text || sendingRef.current || pending) return
    const current = generation.current
    const submission =
      retryMessage.current?.text === text
        ? retryMessage.current
        : { text, requestId: crypto.randomUUID() }
    retryMessage.current = submission
    sendingRef.current = true
    setSending(true)
    setError(undefined)
    shouldFollow.current = true
    try {
      const result = await request<SendResult>({
        action: "send",
        conversationId,
        ...submission,
      })
      if (current !== generation.current) return
      if (result.status === "busy")
        throw new Error(
          "The assistant is working on another request. Try again shortly."
        )
      retryMessage.current = null
      setDraft("")
      const data = await request<ChatMessages>({
        action: "messages",
        conversationId,
      })
      if (current === generation.current) applyMessages(data)
    } catch (reason) {
      if (current === generation.current)
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not send. Try again."
        )
    } finally {
      if (current === generation.current) {
        sendingRef.current = false
        setSending(false)
      }
    }
  }
  async function older() {
    if (!before || !conversationId || loadingHistory) return
    const current = generation.current
    setLoadingHistory(true)
    try {
      const data = await request<ChatMessages>({
        action: "messages",
        conversationId,
        before,
      })
      if (current !== generation.current) return
      shouldFollow.current = false
      setMessages((previous) => [
        ...data.messages,
        ...previous.filter(
          (message) => !data.messages.some((older) => older.id === message.id)
        ),
      ])
      setBefore(data.nextCursor)
    } catch (reason) {
      if (current === generation.current)
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not load earlier messages."
        )
    } finally {
      if (current === generation.current) setLoadingHistory(false)
    }
  }
  return (
    <section
      className={`datool-chat ${className}`}
      style={style}
      aria-label={`${title} chat`}
    >
      <header className="datool-chat-header">
        <strong>{title}</strong>
        <span>Powered by Datool</span>
      </header>
      <div
        className="datool-chat-messages"
        ref={log}
        role="log"
        aria-label="Messages"
        aria-live="polite"
        tabIndex={0}
        onScroll={() => {
          if (log.current)
            shouldFollow.current =
              log.current.scrollHeight -
                log.current.scrollTop -
                log.current.clientHeight <
              80
        }}
      >
        {before && (
          <button
            type="button"
            className="datool-chat-history"
            disabled={loadingHistory}
            onClick={() => void older()}
          >
            {loadingHistory ? "Loading…" : "Earlier messages"}
          </button>
        )}
        {loading ? (
          <p role="status">Opening chat…</p>
        ) : messages.length === 0 ? (
          <div className="datool-chat-welcome">{welcomeMessage}</div>
        ) : null}
        {messages.map((message) => (
          <article
            key={message.id}
            className={`datool-chat-message datool-chat-message-${message.role}`}
          >
            <span className="datool-chat-sr-only">
              {message.role === "user" ? "You" : title}:{" "}
            </span>
            {message.text}
          </article>
        ))}
        {(sending || pending) && (
          <p className="datool-chat-pending" role="status">
            {title} is working…
          </p>
        )}
      </div>
      {error && (
        <div className="datool-chat-error" id={errorId} role="alert">
          <span>{error}</span>
          {!conversationId && (
            <button type="button" onClick={reconnect}>
              Reconnect
            </button>
          )}
        </div>
      )}
      <form
        className="datool-chat-composer"
        onSubmit={(event) => void send(event)}
      >
        <label htmlFor={inputId} className="datool-chat-sr-only">
          Message
        </label>
        <textarea
          id={inputId}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={placeholder}
          rows={2}
          maxLength={20_000}
          disabled={loading || !conversationId || sending}
          aria-describedby={error ? errorId : undefined}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
        />
        <button
          type="submit"
          disabled={!draft.trim() || !conversationId || sending || pending}
        >
          Send
        </button>
      </form>
    </section>
  )
}
