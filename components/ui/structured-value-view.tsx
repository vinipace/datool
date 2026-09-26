import type { JsonValue } from "@/src/lib/tracer/contracts"
import { formatValueView, type ValueView } from "@/src/lib/tracer/value-views"
import { SyntaxCode } from "./syntax-code"
import { MessageTranscript } from "./message-transcript"
import { normaliseOutputMessages } from "@/src/lib/tracer/value-messages"
import { isMessageView, resolveValueView } from "@/src/lib/tracer/value-views"
import { imageValue } from "@/src/lib/tracer/value-images"
import { ImageValuePreview } from "./image-value-preview"

export function ValueTree({
  value,
  name = "root",
  depth = 0,
}: {
  value: JsonValue
  name?: string
  depth?: number
}) {
  if (!value || typeof value !== "object" || depth > 12)
    return (
      <div className="py-1 font-mono text-xs">
        <span className="text-foreground-muted">{name}: </span>
        <SyntaxCode text={JSON.stringify(value)} language="json" />
      </div>
    )
  return (
    <details
      open={depth < 2}
      className="ml-2 border-l border-border pl-3 text-xs"
    >
      <summary className="cursor-pointer py-1 text-foreground-muted">
        {name} <span>({Object.keys(value).length})</span>
      </summary>
      {Object.entries(value).map(([key, child]) => (
        <ValueTree
          key={key}
          name={key}
          value={child ?? null}
          depth={depth + 1}
        />
      ))}
    </details>
  )
}

export function StructuredValueView({
  value,
  view,
  compact = false,
  inputValue,
}: {
  value: JsonValue
  view: ValueView
  compact?: boolean
  inputValue?: JsonValue
}) {
  view = resolveValueView(value, view)
  if (view === "image") {
    const image = imageValue(value)
    if (image) return <ImageValuePreview key={image.url} {...image} />
  }
  if (isMessageView(view)) {
    const messages = normaliseOutputMessages(value, inputValue)
    if (messages?.length === 0)
      return <p className="text-foreground-muted">No new output messages.</p>
    if (messages)
      return <MessageTranscript messages={messages} raw={view === "llm-raw"} />
  }
  if (view === "tree") return <ValueTree value={value} />
  const text = formatValueView(value, view, compact)
  return view === "json" || view === "pretty" || view === "yaml" ? (
    <SyntaxCode text={text} language={view === "yaml" ? "yaml" : "json"} />
  ) : (
    <span className="font-mono whitespace-pre-wrap">{text}</span>
  )
}
