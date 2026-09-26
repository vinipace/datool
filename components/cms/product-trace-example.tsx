"use client"

import { useRef, useState } from "react"
import { Clock3, Search } from "lucide-react"
import { SpanNavigator } from "@/components/tracer/trace-inspector"
import { TraceTimeline } from "@/components/tracer/trace-timeline"
import { SpanKindIcon } from "@/components/tracer/span-kind-icon"
import { PayloadSection } from "@/components/ui/payload-section"
import { StructuredValueViewer } from "@/components/ui/structured-value-viewer"
import { productExampleTrace } from "./product-trace-fixture"
import styles from "./product.module.css"

const trace = productExampleTrace
const spans = trace.spans
const findings: Record<string, string> = {
  support:
    "One request connects the question, retrieval, model call, and verification.",
  retrieve:
    "Search takes 68% of this run. It found the correct 30-day return policy.",
  generate:
    "The answer contradicts the retrieved policy. This is the step to investigate.",
  verify:
    "The check caught the mismatch. Keep this example for your next evaluation.",
}

/** The production span hierarchy and payload controls, with self-contained example data. */
export function ProductTraceExample({
  compact = false,
  navigation = "tree",
}: {
  compact?: boolean
  navigation?: "tree" | "timeline"
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [selectedId, setSelectedId] = useState(
    compact ? "retrieve" : "generate"
  )
  const selected = spans.find((span) => span.id === selectedId) ?? spans[0]
  return (
    <div className={styles.realTrace} data-compact={compact}>
      {compact && (
        <div className={styles.realTraceHeader}>
          <SpanKindIcon kind="agent" />
          <strong>support.agent</strong>
          <span>
            <Clock3 size={13} aria-hidden="true" /> 2.8s
          </span>
          <span>4 spans</span>
        </div>
      )}
      <div className={styles.realTraceGrid}>
        <div
          className={
            navigation === "timeline"
              ? styles.realTimeline
              : styles.realSpanNavigation
          }
        >
          {navigation === "timeline" ? (
            <TraceTimeline
              trace={trace}
              selectedSpanId={selected.id}
              onSelectSpan={(id) => setSelectedId(id ?? "support")}
            />
          ) : (
            <SpanNavigator
              scrollRef={scrollRef}
              trace={trace}
              selectedSpanId={selected.id}
              onSelectSpan={(id) => setSelectedId(id ?? "support")}
            />
          )}
        </div>
        <div className={styles.realPayload} aria-label="Selected span details">
          <div className={styles.realSpanHeading}>
            <SpanKindIcon kind={selected.kind} />
            <strong>{selected.name}</strong>
            <span>{selected.durationMs}ms</span>
          </div>
          {!compact && (
            <PayloadSection key={`${selected.id}-input`} label="Input">
              <StructuredValueViewer
                label="Span input"
                value={selected.input}
              />
            </PayloadSection>
          )}
          <PayloadSection key={`${selected.id}-output`} label="Output">
            <StructuredValueViewer
              label="Span output"
              value={selected.output}
            />
          </PayloadSection>
        </div>
      </div>
      <div className={styles.realTraceFinding}>
        <Search size={16} aria-hidden="true" />
        <p>{findings[selected.id]}</p>
      </div>
    </div>
  )
}
