"use client"

import { useMemo, useState } from "react"
import { Bot, ChevronRight, UserRound } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type {
  InspectorMessage,
  InspectorToolCall,
} from "@/src/lib/tracer/value-messages"
import { groupToolResults, toolResultFailed } from "@/src/lib/tracer/value-messages"
import { SyntaxCode } from "./syntax-code"
import { CodeEditor } from "./code-editor"
import { SpanKindIcon } from "@/components/tracer/span-kind-icon"
import { cn } from "@/lib/utils"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function messageText(value: unknown): string | null {
  if (typeof value === "string") return value
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
      return { text: JSON.stringify(JSON.parse(value), null, 2), language: "json" as const }
    } catch {
      // Truncated or non-JSON captures remain available exactly as captured.
      return { text: value, language: "plaintext" as const }
    }
  }
  return { text: JSON.stringify(value, null, 2) ?? "undefined", language: "json" as const }
}

function ToolResult({ result, name }: { result: InspectorMessage; name: string }) {
  const document = useMemo(() => capturedDocument(result.content), [result.content])
  const failed = toolResultFailed(result)
  return <div role="group" aria-label={`${name} output`} className="border-t border-border">
    <div className={cn("flex items-center justify-between px-2.5 py-2 text-xs",
      failed ? "bg-destructive-background text-destructive" : "bg-success-background text-success-foreground")}>
      <span>Output</span><span>{failed ? "Failed" : "Succeeded"}</span>
    </div>
    <CodeEditor label={`${name} result`} language={document.language} value={document.text}
      onChange={() => undefined} readOnly autoSize lineNumbers={false} variant="embedded"
      tone={failed ? "error" : "success"} />
  </div>
}

function ToolCall({ toolCall, results }: { toolCall: InspectorToolCall; results: InspectorMessage[] }) {
  const [open, setOpen] = useState(false)
  const document = useMemo(() => capturedDocument(toolCall.arguments), [toolCall.arguments])
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
          {results.map((result, index) => <ToolResult key={index} result={result} name={toolCall.name} />)}
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
}: {
  messages: InspectorMessage[]
  raw?: boolean
  variant?: "default" | "chat" | "bubbles"
}) {
  const transcript = useMemo(() => groupToolResults(messages), [messages])
  return (
    <div className="space-y-3 font-sans whitespace-normal">
      {transcript.map(({ message, toolResults }, index) => {
        const text = messageText(message.content)
        const isUser = message.role.toLowerCase() === "user"
        const needsFallback =
          (text === null &&
            !(message.content === null && message.toolCalls.length > 0)) ||
          (Array.isArray(message.content) &&
            message.content.some((part) => !isTextOrToolPart(part)))
        return (
          <article
            key={`${message.role}-${index}`}
            className={cn(
              "min-w-0 py-1",
              (variant !== "default" || isUser) && "flex flex-col items-start",
              isUser && "items-end"
            )}
          >
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-foreground-muted capitalize",
                variant !== "bubbles" && "bg-muted"
              )}
            >
              {isUser ? (
                <UserRound className="size-3.5" />
              ) : (
                <Bot className="size-3.5" />
              )}
              {message.role}
            </span>
            {text !== null && (
              <div
                className={cn(
                  "mt-1.5 text-sm leading-6 [overflow-wrap:anywhere] text-foreground",
                  (isUser || variant === "bubbles") &&
                    "w-fit max-w-full rounded-2xl border border-border bg-muted px-3 py-2",
                  isUser &&
                    "max-w-[85%] min-w-8 border-message-user bg-message-user text-right text-message-user-foreground",
                  variant === "bubbles" && "px-4 py-3",
                  variant === "bubbles" &&
                    (isUser ? "rounded-tr-sm" : "rounded-tl-sm")
                )}
              >
                {raw ? (
                  <p className="whitespace-pre-wrap">{text}</p>
                ) : (
                  <div
                    className={cn(
                      "space-y-2 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:text-lg [&_h2]:text-base [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_table]:block [&_table]:overflow-auto [&_td]:border [&_td]:border-border [&_td]:p-2 [&_th]:border [&_th]:border-border [&_th]:p-2 [&_ul]:list-disc [&_ul]:pl-5",
                      isUser &&
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
                              language={language === "json" ? "json" : "yaml"}
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
          </article>
        )
      })}
    </div>
  )
}
