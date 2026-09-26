"use client"

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react"
import { ArrowRight, Check, GitBranch, Play } from "lucide-react"
import { KindIcon } from "@/components/ui/kind-icon"
import { ProgressButton } from "@/components/ui/progress-button"
import { DatasetKindIcon } from "@/components/tracer/dataset-kind-icon"
import { SpanKindIcon } from "@/components/tracer/span-kind-icon"
import styles from "./landing.module.css"

const stages = [
  {
    id: "trace",
    label: "Trace",
    title: "Every step. Nothing hidden.",
    description:
      "Follow one request through retrieval, generation, and verification.",
    center: "ai.agent",
    centerKind: "agent",
    nodes: ["retrieve", "generate", "verify"],
    nodeKinds: ["tool", "llm", "score"],
    details: ["4 documents", "1 model call", "1 flagged answer"],
  },
  {
    id: "evaluate",
    label: "Evaluate",
    title: "An unexpected answer becomes a test.",
    description:
      "Keep the example, score its output, and establish a baseline.",
    center: "app.invoke",
    centerKind: "play",
    nodes: ["dataset", "scorer", "baseline"],
    nodeKinds: ["dataset", "score", "eval"],
    details: ["Case saved", "Groundedness", "Issue reproduced"],
  },
  {
    id: "improve",
    label: "Improve",
    title: "See what your next change changes.",
    description:
      "Run the same cases again and compare the results before you ship.",
    center: "compare.runs",
    centerKind: "eval",
    nodes: ["baseline", "candidate", "comparison"],
    nodeKinds: ["eval", "eval", "score"],
    details: ["18 / 24 pass", "23 / 24 pass", "5 cases improved"],
  },
] as const

const traceSpans = [
  { name: "ai.workflow", kind: "workflow", start: 0, width: 100 },
  { name: "retrieve", kind: "tool", start: 0, width: 24 },
  { name: "generate", kind: "llm", start: 24, width: 62 },
  { name: "verify", kind: "score", start: 86, width: 14 },
] as const

function subscribeToAutomaticPlayback(onChange: () => void) {
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)")
  motion.addEventListener("change", onChange)
  document.addEventListener("visibilitychange", onChange)
  return () => {
    motion.removeEventListener("change", onChange)
    document.removeEventListener("visibilitychange", onChange)
  }
}

function automaticPlaybackAllowed() {
  return (
    !document.hidden &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

export function RequestStory({
  stageDurationMs = 6000,
}: {
  stageDurationMs?: number
}) {
  const [{ active, cycle }, setStep] = useState({ active: 0, cycle: 0 })
  const [inView, setInView] = useState(false)
  const figureRef = useRef<HTMLElement>(null)
  const automaticPlayback = useSyncExternalStore(
    subscribeToAutomaticPlayback,
    automaticPlaybackAllowed,
    () => false
  )
  const playing = automaticPlayback && inView
  const id = useId()
  const stage = stages[active]

  useEffect(() => {
    const figure = figureRef.current
    if (!figure) return
    const observer = new IntersectionObserver(
      ([entry]) =>
        setInView(entry.isIntersecting && entry.intersectionRatio >= 0.35),
      { threshold: 0.35 }
    )
    observer.observe(figure)
    return () => observer.disconnect()
  }, [])

  function selectStage(index: number) {
    setStep((previous) => ({ active: index, cycle: previous.cycle + 1 }))
  }

  function advanceStage() {
    setStep((previous) => ({
      active: (previous.active + 1) % stages.length,
      cycle: previous.cycle + 1,
    }))
  }

  return (
    <figure
      ref={figureRef}
      className={styles.story}
      data-stage={stage.id}
      data-playing={playing}
      aria-label="From a request to a better result"
    >
      <svg
        viewBox="0 0 560 400"
        className={styles.signalGraphic}
        role="img"
        aria-labelledby={`${id}-title ${id}-description`}
      >
        <title id={`${id}-title`}>{stage.title}</title>
        <desc id={`${id}-description`}>
          {stage.description} Illustrative workflow, not live customer data.
        </desc>
        <defs>
          <radialGradient id={`${id}-glow`}>
            <stop stopColor="var(--story-signal)" stopOpacity=".13" />
            <stop offset="1" stopColor="var(--story-signal)" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`${id}-signal`} x1="0" y1="0" x2="1" y2="0">
            <stop stopColor="var(--story-signal)" stopOpacity="0" />
            <stop
              offset=".52"
              stopColor="var(--story-signal)"
              stopOpacity=".7"
            />
            <stop offset="1" stopColor="var(--story-signal)" />
          </linearGradient>
          <pattern
            id={`${id}-grid`}
            width="24"
            height="24"
            patternUnits="userSpaceOnUse"
          >
            <circle
              cx="1"
              cy="1"
              r=".65"
              fill="var(--foreground-muted)"
              opacity=".22"
            />
          </pattern>
        </defs>
        <rect
          x="22"
          y="15"
          width="516"
          height="355"
          fill={`url(#${id}-grid)`}
        />
        <ellipse
          cx="254"
          cy="202"
          rx="245"
          ry="194"
          fill={`url(#${id}-glow)`}
        />
        <g fill="none" stroke="var(--border)" strokeWidth="1">
          <circle cx="254" cy="202" r="120" strokeDasharray="3 9" />
          <circle cx="254" cy="202" r="76" />
          <path d="M254 47V72M254 332V355M109 202H124M379 202H394" />
        </g>
        <g fill="none" stroke={`url(#${id}-signal)`}>
          {Array.from({ length: 23 }, (_, i) => (
            <path
              key={i}
              className={styles.incomingPath}
              d={`M-24 ${34 + i * 15} C ${92 + i * 2} ${8 + i * 17}, ${94 + i * 3} ${202 + (i - 11) * 2}, 228 ${202 + (i - 11) * 0.65}`}
              strokeWidth={i === 11 ? 2.8 : 2}
              opacity={i === 11 ? 1 : 0.45 + (i % 4) * 0.12}
              style={{ animationDelay: `${-i * 0.09}s` }}
            />
          ))}
          <path
            key={active}
            className={styles.drawPaths}
            d="M279 202H305C349 202 328 87 382 87H401M279 202H401M279 202H305C349 202 328 317 382 317H401"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </g>
        <g className={styles.centralNode}>
          <rect x="225" y="173" width="58" height="58" rx="17" />
          <foreignObject
            x="238"
            y="186"
            width="32"
            height="32"
            aria-hidden="true"
          >
            {stage.centerKind === "play" ? (
              <KindIcon
                icon={Play}
                className="size-8 rounded-lg bg-marketing-run text-background [&>svg]:size-5 [&>svg]:fill-background"
              />
            ) : (
              <SpanKindIcon
                kind={stage.centerKind}
                className="size-8 rounded-lg [&>svg]:size-5"
              />
            )}
          </foreignObject>
        </g>
        <text
          x="254"
          y="260"
          textAnchor="middle"
          className={styles.diagramLabel}
        >
          {stage.center}
        </text>
        {stage.nodes.map((node, i) => {
          const y = 87 + i * 115
          const flagged = active < 2 && i === 2
          const kind = stage.nodeKinds[i]
          return (
            <g key={node}>
              <circle
                cx="382"
                cy={y}
                r="3"
                fill={flagged ? "var(--warning)" : "var(--story-signal)"}
              />
              <rect
                x="401"
                y={y - 23}
                width="141"
                height="46"
                rx="7"
                className={styles.graphNode}
              />
              <foreignObject
                x="410"
                y={y - 11}
                width="22"
                height="22"
                aria-hidden="true"
              >
                {kind === "dataset" ? (
                  <span className="flex size-[22px] items-center justify-center [&>svg]:size-4">
                    <DatasetKindIcon kind="dataset" />
                  </span>
                ) : (
                  <SpanKindIcon kind={kind} className="size-[22px]" />
                )}
              </foreignObject>
              <text x="441" y={y + 4} className={styles.diagramLabel}>
                {node}
              </text>
              <text x="407" y={y + 43} className={styles.diagramDetail}>
                {stage.details[i]}
              </text>
            </g>
          )
        })}
      </svg>
      <div
        className={styles.storyControls}
        role="group"
        aria-label="Explore the workflow"
      >
        {stages.map(({ label }, i) => (
          <ProgressButton
            key={label}
            active={active === i}
            durationMs={stageDurationMs}
            restartKey={cycle}
            paused={!playing}
            onProgressComplete={advanceStage}
            variant={active === i ? "secondary" : "ghost-muted"}
            size="sm"
            aria-pressed={active === i}
            aria-controls={`${id}-detail`}
            onClick={() => selectStage(i)}
          >
            <span
              className={
                active === i ? styles.stageNumber : "text-foreground-muted"
              }
            >
              0{i + 1}
            </span>
            {label}
          </ProgressButton>
        ))}
      </div>
      <figcaption
        id={`${id}-detail`}
        aria-live={playing ? "off" : "polite"}
        aria-atomic="true"
      >
        <div className={styles.storyCaption}>
          <p>{stage.title}</p>
          <p>{stage.description}</p>
        </div>
      </figcaption>
    </figure>
  )
}

export function FeatureVisual({ index }: { index: number }) {
  return (
    <div className={styles.featureVisual} aria-hidden="true">
      {index === 0 ? (
        <div className={styles.traceRows}>
          <div className={styles.traceAxis}>
            <span>SPAN</span>
            <div>
              <span>0</span>
              <span>0.62s</span>
              <span>1.24s</span>
            </div>
          </div>
          {traceSpans.map(({ name, kind, start, width }, i) => (
            <div key={name} className={styles.traceRow} data-child={i > 0}>
              <span className={styles.traceName}>
                <SpanKindIcon
                  kind={kind}
                  className="size-3.5 rounded-[2px] [&>svg]:size-2.5"
                />
                <span>{name}</span>
              </span>
              <span className={styles.traceTrack}>
                <i
                  data-warning={kind === "score"}
                  style={{ left: `${start}%`, width: `${width}%` }}
                />
              </span>
            </div>
          ))}
          <div className={styles.traceFlag}>
            <span /> verify · unexpected output <ArrowRight size={12} />
          </div>
        </div>
      ) : index === 1 ? (
        <div className={styles.caseGraphic}>
          <div className={styles.savedCase}>
            <GitBranch size={17} />
            <span>
              From trace
              <br />
              <strong>to test case</strong>
            </span>
          </div>
          <svg viewBox="0 0 90 112" fill="none">
            <path
              d="M0 56H20C49 56 29 16 65 16H90M20 56H90M20 56C49 56 29 96 65 96H90"
              stroke="var(--marketing-signal)"
              strokeWidth="1"
            />
          </svg>
          <div className={styles.caseChecks}>
            {["Input", "Expected", "Scorer"].map((label) => (
              <span key={label}>
                <Check size={12} />
                {label}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div className={styles.compareGraphic}>
          <div>
            <span>Baseline</span>
            <span>Candidate</span>
          </div>
          <div className={styles.caseMatrix}>
            {Array.from({ length: 24 }, (_, i) => (
              <i key={i} data-pass={i < 18} />
            ))}
          </div>
          <div className={styles.caseMatrix}>
            {Array.from({ length: 24 }, (_, i) => (
              <i key={i} data-pass={i < 23} />
            ))}
          </div>
          <p>
            <span>Same cases. Clearer results.</span>
            <ArrowRight size={14} />
          </p>
        </div>
      )}
    </div>
  )
}

export function SignalLoop() {
  return (
    <svg
      className={styles.loop}
      viewBox="0 0 600 340"
      fill="none"
      aria-hidden="true"
    >
      {Array.from({ length: 16 }, (_, i) => (
        <path
          key={i}
          d={`M${610 + i * 9} ${27 + i * 7} C ${120 - i * 9} ${-80 + i * 9}, ${134 - i * 4} ${421 - i * 6}, ${610 + i * 8} ${259 - i * 3}`}
          stroke="var(--marketing-signal)"
          strokeOpacity={0.08 + i * 0.022}
          strokeWidth="1"
        />
      ))}
      <circle cx="325" cy="171" r="7" fill="var(--marketing-signal)" />
      <circle
        cx="325"
        cy="171"
        r="17"
        stroke="var(--marketing-signal)"
        strokeOpacity=".3"
      />
    </svg>
  )
}
