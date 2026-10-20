"use client"

import { useMemo, useState, type ReactNode } from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { Bot, ChevronRight, UserRound } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type {
  InspectorMessage,
  InspectorToolCall,
} from "@/src/lib/tracer/value-messages"
import {
  groupToolResults,
  toolResultFailed,
} from "@/src/lib/tracer/value-messages"
import { SyntaxCode } from "./syntax-code"
import { CodeEditor } from "./code-editor"
import { UserAvatarImage } from "./user-avatar"
import { AgentAvatar } from "./agent-avatar"
import { SpanKindIcon } from "@/components/tracer/span-kind-icon"
import { cn } from "@/lib/utils"
import {
  ChatRichContent,
  type ChatInteractionHandler,
} from "./chat-rich-content"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function messageText(value: unknown): string | null {
  if (typeof value === "string") return value
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text
    if (Array.isArray(value.parts)) return messageText(value.parts)
    if (Array.isArray(value.continuations))
      return value.continuations
        .flatMap((item) =>
          isRecord(item) && typeof item.message === "string"
            ? [item.message]
            : []
        )
        .join("\n")
  }
  if (!Array.isArray(value)) return null
  const pieces = value.flatMap((part) => {
    if (typeof part === "string") return [part]
    return isRecord(part) &&
      part.type === "text" &&
      typeof part.text === "string"
      ? [part.text]
      : []
  })
  return pieces.length ? pieces.join("\n") : null
}

function isTextOrToolPart(value: unknown) {
  return (
    typeof value === "string" ||
    (isRecord(value) &&
      (value.type === "text" ||
        value.type === "tool-call" ||
        value.type === "tool_call"))
  )
}

function CapturedValue({ value }: { value: unknown }) {
  return (
    <div className="font-mono text-xs leading-5 [overflow-wrap:anywhere] whitespace-pre-wrap text-foreground">
      {typeof value === "string" ? (
        value
      ) : (
        <SyntaxCode
          text={JSON.stringify(value, null, 2) ?? "undefined"}
          language="json"
        />
      )}
    </div>
  )
}

function capturedDocument(value: unknown) {
  if (typeof value === "string") {
    try {
      return {
        text: JSON.stringify(JSON.parse(value), null, 2),
        language: "json" as const,
      }
    } catch {
      // Truncated or non-JSON captures remain available exactly as captured.
      return { text: value, language: "plaintext" as const }
    }
  }
  return {
    text: JSON.stringify(value, null, 2) ?? "undefined",
    language: "json" as const,
  }
}

function ToolResult({
  result,
  name,
}: {
  result: InspectorMessage
  name: string
}) {
  const document = useMemo(
    () => capturedDocument(result.content),
    [result.content]
  )
  const failed = toolResultFailed(result)
  return (
    <div
      role="group"
      aria-label={`${name} output`}
      className="border-t border-border"
    >
      <div
        className={cn(
          "flex items-center justify-between px-2.5 py-2 text-xs",
          failed
            ? "bg-destructive-background text-destructive"
            : "bg-success-background text-success-foreground"
        )}
      >
        <span>Output</span>
        <span>{failed ? "Failed" : "Succeeded"}</span>
      </div>
      <CodeEditor
        label={`${name} result`}
        language={document.language}
        value={document.text}
        onChange={() => undefined}
        readOnly
        autoSize
        lineNumbers={false}
        variant="embedded"
        tone={failed ? "error" : "success"}
      />
    </div>
  )
}

function ToolCall({
  toolCall,
  results,
}: {
  toolCall: InspectorToolCall
  results: InspectorMessage[]
}) {
  const [open, setOpen] = useState(false)
  const document = useMemo(
    () => capturedDocument(toolCall.arguments),
    [toolCall.arguments]
  )
  return (
    <details
      className="group/tool min-w-0 rounded-md border border-border bg-muted"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 text-xs font-medium text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden">
        <SpanKindIcon kind="tool" />
        <span className="min-w-0 flex-1 truncate">{toolCall.name}</span>
        <ChevronRight className="size-3.5 text-foreground-muted transition-transform group-open/tool:rotate-90" />
      </summary>
      {open && (
        <div className="overflow-hidden rounded-b-md border-t border-border">
          <p className="px-2.5 py-2 text-xs text-foreground-muted">Input</p>
          <CodeEditor
            label={`${toolCall.name} arguments`}
            language={document.language}
            value={document.text}
            onChange={() => undefined}
            readOnly
            autoSize
            lineNumbers={false}
            variant="embedded"
          />
          {results.map((result, index) => (
            <ToolResult key={index} result={result} name={toolCall.name} />
          ))}
        </div>
      )}
    </details>
  )
}

/** LLM formats render Markdown; LLM Raw retains literal text within the same transcript. */
export function MessageTranscript({
  messages,
  raw = false,
  variant = "default",
  perspective = "customer",
  onWidgetInteraction,
  onCodeStatus,
  renderMessageFooter,
  pendingReply,
}: {
  messages: InspectorMessage[]
  raw?: boolean
  variant?: "default" | "chat" | "bubbles" | "customer"
  perspective?: "customer" | "operator"
  onWidgetInteraction?: ChatInteractionHandler
  onCodeStatus?: (error: string | null) => void
  renderMessageFooter?: (message: InspectorMessage) => ReactNode
  pendingReply?: ReactNode
}) {
  const transcript = useMemo(() => groupToolResults(messages), [messages])
  const completedContinuationIds = useMemo(
    () =>
      new Set(
        messages.flatMap((message) => {
          const id =
            message.role === "assistant"
              ? message.metadata?.completedContinuationId
              : undefined
          return typeof id === "string" ? [id] : []
        })
      ),
    [messages]
  )
  const reducedMotion = useReducedMotion()
  return (
    <div
      className={cn(
        "relative space-y-3 whitespace-normal",
        variant !== "customer" && "font-sans"
      )}
    >
      <AnimatePresence initial={false} mode="popLayout">
        {transcript.map(({ message, toolResults }, index) => {
          const text = messageText(message.content)
          const isUser = message.role.toLowerCase() === "user"
          const isAssistant = message.role.toLowerCase() === "assistant"
          const isOutgoing = perspective === "operator" ? isAssistant : isUser
          const isHumanReply =
            isAssistant && message.metadata?.source === "human"
          const label =
            perspective === "operator"
              ? isUser
                ? "Customer"
                : isAssistant
                  ? isHumanReply
                    ? message.author?.name.trim() || "Unknown sender"
                    : message.author?.name || "Unknown agent"
                  : message.role
              : message.role
          const customer = variant === "customer"
          const needsFallback =
            (text === null &&
              !(message.content === null && message.toolCalls.length > 0)) ||
            (Array.isArray(message.content) &&
              message.content.some((part) => !isTextOrToolPart(part)))
          return (
            <motion.article
              key={message.id ?? `${message.role}-${index}`}
              data-chat-message=""
              layout={customer && !reducedMotion ? "position" : false}
              initial={
                customer && !reducedMotion ? { opacity: 0, y: 5 } : false
              }
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: reducedMotion ? 0 : 0.2,
                ease: "easeOut",
              }}
              aria-label={
                perspective === "operator"
                  ? `${label} message`
                  : customer
                    ? isUser
                      ? "Your message"
                      : "Assistant message"
                    : undefined
              }
              className={cn(
                "min-w-0 py-1",
                (variant !== "default" || isOutgoing) &&
                  "flex flex-col items-start",
                isOutgoing && "items-end"
              )}
            >
              {!customer && (
                <span
                  className={cn(
                    "inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs text-foreground-muted",
                    perspective !== "operator" && "capitalize",
                    variant !== "bubbles" && "bg-muted"
                  )}
                >
                  {perspective === "operator" && isHumanReply ? (
                    <UserAvatarImage
                      name={label}
                      image={message.author?.image ?? null}
                      size="sm"
                    />
                  ) : perspective === "operator" && isAssistant ? (
                    <AgentAvatar
                      appearance={message.author?.agentAvatar}
                      className="size-5"
                    />
                  ) : isUser ? (
                    <UserRound className="size-3.5" />
                  ) : (
                    <Bot className="size-3.5" />
                  )}
                  <span className="min-w-0 truncate">{label}</span>
                  {message.createdAt && (
                    <time
                      className="ml-1 shrink-0 normal-case"
                      dateTime={message.createdAt}
                    >
                      {new Date(message.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  )}
                </span>
              )}
              {(!customer ||
                text ||
                message.toolCalls.length > 0 ||
                needsFallback) && (
                <div
                  data-bubble-message={customer ? "" : undefined}
                  data-bubble-user={customer && isOutgoing ? "" : undefined}
                  className={cn(
                    "max-w-full min-w-0",
                    !customer && !isOutgoing && "w-full",
                    !customer && isOutgoing && "max-w-[85%]",
                    customer &&
                      "max-w-[min(85%,36rem)] rounded-2xl px-4 py-3 text-sm",
                    customer &&
                      (isOutgoing
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-foreground")
                  )}
                >
                  {text !== null && (
                    <div
                      className={cn(
                        "mt-1.5 text-sm leading-6 [overflow-wrap:anywhere] text-foreground",
                        !customer &&
                          (isOutgoing || variant === "bubbles") &&
                          "w-fit max-w-full rounded-2xl border border-border bg-muted px-3 py-2",
                        !customer &&
                          isOutgoing &&
                          "min-w-8 border-message-user bg-message-user text-message-user-foreground",
                        !customer &&
                          isOutgoing &&
                          perspective === "customer" &&
                          "text-right",
                        variant === "bubbles" && "px-4 py-3",
                        variant === "bubbles" &&
                          (isOutgoing ? "rounded-tr-sm" : "rounded-tl-sm"),
                        customer && "mt-0 text-inherit"
                      )}
                    >
                      {raw ? (
                        <p className="whitespace-pre-wrap">{text}</p>
                      ) : (
                        <div
                          className={cn(
                            "space-y-2 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:text-lg [&_h2]:text-base [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_table]:block [&_table]:overflow-auto [&_td]:border [&_td]:border-border [&_td]:p-2 [&_th]:border [&_th]:border-border [&_th]:p-2 [&_ul]:list-disc [&_ul]:pl-5",
                            isOutgoing &&
                              "[&_blockquote]:border-message-user-foreground/20 [&_code]:bg-message-user-foreground/10 [&_pre]:bg-message-user-foreground/10 [&_td]:border-message-user-foreground/20 [&_th]:border-message-user-foreground/20"
                          )}
                        >
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              code: ({ className, children }) => {
                                const language =
                                  /(?:^|\s)language-(json|ya?ml)(?:\s|$)/.exec(
                                    className ?? ""
                                  )?.[1]
                                return !isUser &&
                                  language &&
                                  typeof children === "string" ? (
                                  <SyntaxCode
                                    text={children}
                                    language={
                                      language === "json" ? "json" : "yaml"
                                    }
                                  />
                                ) : (
                                  <code className={className}>{children}</code>
                                )
                              },
                            }}
                          >
                            {text}
                          </ReactMarkdown>
                        </div>
                      )}
                    </div>
                  )}
                  {message.toolCalls.length > 0 && (
                    <div className="mt-3 w-full min-w-0 space-y-2">
                      {message.toolCalls.map((toolCall, toolIndex) => (
                        <ToolCall
                          key={toolCall.id ?? `${toolCall.name}-${toolIndex}`}
                          toolCall={toolCall}
                          results={toolResults[toolIndex]}
                        />
                      ))}
                    </div>
                  )}
                  {needsFallback && (
                    <div className="mt-3">
                      <p className="mb-1 text-[10px] font-medium tracking-wide text-foreground-muted uppercase">
                        Captured content
                      </p>
                      <CapturedValue value={message.content} />
                    </div>
                  )}
                  {!customer && (
                    <ChatRichContent
                      message={message}
                      completedContinuationIds={completedContinuationIds}
                      onInteraction={onWidgetInteraction}
                      onCodeStatus={onCodeStatus}
                    />
                  )}
                  {!customer && renderMessageFooter?.(message)}
                </div>
              )}
              {customer && (
                <ChatRichContent
                  message={message}
                  variant="customer"
                  completedContinuationIds={completedContinuationIds}
                  onInteraction={onWidgetInteraction}
                  onCodeStatus={onCodeStatus}
                />
              )}
              {customer && renderMessageFooter?.(message)}
            </motion.article>
          )
        })}
        {pendingReply ? (
          <motion.div
            key="pending-reply"
            className="flex justify-start py-1"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion ? 0 : 0.16 }}
          >
            {pendingReply}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
