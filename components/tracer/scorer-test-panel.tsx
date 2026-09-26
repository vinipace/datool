"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import {
  Braces,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  Play,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { CodeEditor } from "@/components/ui/code-editor"

import { PayloadSection } from "@/components/ui/payload-section"
import { InspectorSection } from "@/components/ui/inspector-section"
import { Notice } from "@/components/ui/notice"
import { StructuredValueViewer } from "@/components/ui/structured-value-viewer"
import type {
  EvaluatorRunResult,
  JsonValue,
  TraceSummary,
} from "@/src/lib/tracer/contracts"
import type { ScorerInput } from "@/src/lib/tracer/scorers"
import { projectFetch } from "@/lib/workspace-routing"
import { tracerApi } from "./api"
import { useRemote } from "./hooks"
import { EmptyState, ErrorState, LoadingState } from "./primitives"
import { PercentageCell } from "./percentage-cell"
import { ScorerTracePicker } from "./scorer-trace-picker"
import { SpanKindIcon } from "./span-kind-icon"
import { getTraceIconKind } from "./trace-icon-kind"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

const sampleJson = JSON.stringify(
  { input: "What is 2 + 2?", output: "4", expected: "4" },
  null,
  2
)
type TestCase = {
  id: string
  label: string
  traceId?: string
  trace?: TraceSummary
  sample: string
  pending?: boolean
  result?: EvaluatorRunResult
  error?: string
  configKey?: string
}

export function ScorerTestPanel({
  config,
  actionsContainer,
  traceIds,
  disabled = false,
  onModelError,
}: {
  config: ScorerInput
  actionsContainer?: HTMLElement | null
  traceIds: string[]
  disabled?: boolean
  onModelError?: () => void
}) {
  const [cases, setCases] = React.useState<TestCase[]>(() =>
    traceIds.length
      ? [...new Set(traceIds)].map((id) => ({
          id,
          label: id,
          traceId: id,
          sample: "",
        }))
      : [{ id: "json-1", label: "JSON 1", sample: sampleJson }]
  )
  const nextJson = React.useRef(2)
  const inFlight = React.useRef(new Set<string>())
  const runAllButton = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Enter" ||
        !event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        event.isComposing
      )
        return
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) runAllButton.current?.click()
    }
    // Capture before Monaco handles the shortcut; the button owns disabled state.
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [])
  const configKey = JSON.stringify(config)
  const latestConfigKey = React.useRef(configKey)
  React.useEffect(() => { latestConfigKey.current = configKey }, [configKey])
  const patch = (id: string, values: Partial<TestCase>) =>
    setCases((current) =>
      current.map((item) => (item.id === id ? { ...item, ...values } : item))
    )

  async function run(items: TestCase[]) {
    let modelErrorReported = false
    const reportModelError = () => {
      if (modelErrorReported || latestConfigKey.current !== configKey) return
      modelErrorReported = true
      onModelError?.()
    }
    // Reserve every case synchronously so rapid clicks cannot duplicate requests.
    const queue = items.filter((item) => !inFlight.current.has(item.id))
    for (const item of queue) inFlight.current.add(item.id)
    const ids = new Set(queue.map((item) => item.id))
    setCases((current) =>
      current.map((item) =>
        ids.has(item.id)
          ? {
              ...item,
              pending: true,
            }
          : item
      )
    )
    async function worker() {
      for (let item = queue.shift(); item; item = queue.shift()) {
        try {
          let sample: unknown
          if (!item.traceId) {
            try {
              sample = JSON.parse(item.sample)
            } catch {
              throw new Error("Enter valid JSON with input and output values.")
            }
            if (
              !sample ||
              typeof sample !== "object" ||
              Array.isArray(sample) ||
              !("input" in sample) ||
              !("output" in sample)
            ) {
              throw new Error(
                "JSON must be an object with input and output values; expected is optional."
              )
            }
          }
          const response = await projectFetch("/api/scorers/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              code: config.code,
              config: {
                ...config,
                name: config.name || "Preview",
                slug: config.slug || "preview",
              },
              threshold: config.threshold,
              ...(item.traceId ? { traceId: item.traceId } : { sample }),
            }),
          })
          const payload = await response.json()
          if (!response.ok) {
            if (config.type === "llm" && !config.model.trim()) reportModelError()
            throw new Error(payload.error?.message ?? "Unable to run scorer.")
          }
          // Trace tests wrap the execution result; JSON tests return it directly.
          const result: EvaluatorRunResult = payload.data.result ?? payload.data
          if (config.type === "llm" && result.error && (
            result.metadata?.judgeErrorField === "model" ||
            [401, 402, 403, 404].includes(Number(result.metadata?.judgeHttpStatus))
          )) reportModelError()
          patch(item.id, { result, error: result.error?.message, configKey })
        } catch (error) {
          patch(item.id, {
            result: undefined,
            configKey,
            error:
              error instanceof Error ? error.message : "Unable to run scorer.",
          })
        } finally {
          inFlight.current.delete(item.id)
          patch(item.id, { pending: false })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker))
  }

  const actions = (
    <div className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={runAllButton}
            aria-label="Run all"
            aria-keyshortcuts="Meta+Enter"
            variant="default"
            className="rounded-full"
            size="lg"
            disabled={
              disabled || !cases.length || cases.some((item) => item.pending)
            }
            onClick={() => void run(cases)}
          >
            <Play className="fill-current" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Run All</TooltipContent>
      </Tooltip>
    </div>
  )

  return (
    <section
      aria-label="Scorer tests"
      className="flex min-w-0 flex-col bg-[url(/test-bg.png)] bg-repeat-x"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-border px-6 py-4">
        <h2 className="text-base font-bold">
          Preview the scorer
          {cases.some(
            (item) =>
              item.configKey !== undefined && item.configKey !== configKey
          ) && (
            <>
              {" "}
              <span className="font-normal text-warning">- outdated</span>
            </>
          )}
        </h2>
        {actionsContainer
          ? createPortal(actions, actionsContainer)
          : actionsContainer === undefined
            ? actions
            : null}
      </div>
      {!cases.length && (
        <EmptyState
          icon={Braces}
          title="Add data to test your scorer"
          detail="Choose JSON or recorded traces from Add data, then run them individually or together."
        />
      )}
      <div className="min-w-0 border-t">
        {cases.map((item, index) => (
          <ScorerTestCase
            key={item.id}
            item={item}
            defaultOpen={index === 0 || !item.traceId}
            stale={item.configKey !== undefined && item.configKey !== configKey}
            disabled={disabled}
            onRun={() => void run([item])}
            onRemove={() =>
              setCases((current) =>
                current.filter((test) => test.id !== item.id)
              )
            }
            onChange={(sample) =>
              patch(item.id, {
                sample,
                result: undefined,
                error: undefined,
                configKey: undefined,
              })
            }
          />
        ))}
        <div className="border-b border-border">
          <ScorerTracePicker
            className="-ml-2.5 py-5 text-muted-foreground"
            excludedIds={cases.flatMap((item) =>
              item.traceId ? [item.traceId] : []
            )}
            onAdd={(trace) =>
              setCases((current) =>
                current.some((item) => item.traceId === trace.id)
                  ? current
                  : [
                      ...current,
                      {
                        id: trace.id,
                        traceId: trace.id,
                        trace,
                        label: trace.name || trace.id,
                        sample: "",
                      },
                    ]
              )
            }
            onAddJson={() => {
              const number = nextJson.current++
              setCases((current) => [
                ...current,
                {
                  id: `json-${number}`,
                  label: `JSON ${number}`,
                  sample: sampleJson,
                },
              ])
            }}
          />
        </div>
      </div>
    </section>
  )
}

function ScorerTestCase({
  item,
  defaultOpen,
  stale,
  disabled,
  onRun,
  onRemove,
  onChange,
}: {
  item: TestCase
  defaultOpen: boolean
  stale: boolean
  disabled: boolean
  onRun: () => void
  onRemove: () => void
  onChange: (sample: string) => void
}) {
  const [open, setOpen] = React.useState(defaultOpen)
  const contentId = React.useId()
  const payload = useRemote(
    React.useCallback(
      (signal: AbortSignal) => tracerApi.traces.payload(item.traceId!, signal),
      [item.traceId]
    ),
    [item.traceId],
    { enabled: !!item.traceId && open }
  )
  const trace = payload.data ?? item.trace
  const label = trace?.name || item.label
  const status = item.pending
    ? "running"
    : item.error
      ? "error"
      : item.result
        ? item.result.passed === true
          ? "passed"
          : item.result.passed === false
            ? "failed"
            : item.result.score == null
              ? "skipped"
              : "completed"
        : null
  const statusText = status
    ? `${status[0].toUpperCase()}${status.slice(1)}${stale && !item.pending ? " · Outdated" : ""}`
    : ""
  return (
    <article
      aria-label={`Test case ${label}`}
      className="@container/test-case min-w-0 border-b border-border"
    >
      <div className="flex items-center gap-2 py-3 pr-3">
        <div className="flex min-w-0 flex-1 items-center">
          <Button
            variant="ghost"
            size="default"
            className="min-w-0 shrink justify-start"
            aria-label={label}
            aria-expanded={open}
            aria-controls={contentId}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <ChevronDown /> : <ChevronRight />}
            {item.traceId ? (
              <SpanKindIcon kind={trace ? getTraceIconKind(trace) : "custom"} />
            ) : (
              <Braces />
            )}
            <span className="truncate">{label}</span>
          </Button>
          <span className="flex size-2 shrink-0 items-center justify-center">
            {status && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    tabIndex={0}
                    role="img"
                    aria-label={statusText}
                    className={`size-2 shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      item.pending || stale || status === "skipped"
                        ? "bg-warning"
                        : status === "error" || status === "failed"
                          ? "bg-destructive"
                          : "bg-success"
                    }`}
                  />
                </TooltipTrigger>
                <TooltipContent>{statusText}</TooltipContent>
              </Tooltip>
            )}
          </span>
        </div>
        <div
          className="flex w-20 shrink-0 items-center"
          role="status"
          aria-label={`Result for ${label}`}
          aria-busy={item.pending || undefined}
        >
          <span className={item.pending ? "blur-sm" : undefined}>
            {item.result && !item.error && (
              <PercentageCell value={item.result.score} />
            )}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Run ${label}`}
          title={`Run ${label}`}
          aria-busy={item.pending || undefined}
          disabled={disabled || item.pending}
          onClick={onRun}
        >
          {item.pending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Play className="fill-current" />
          )}
        </Button>
        <Button
          variant="ghost-muted"
          size="icon-sm"
          aria-label={`Remove ${label}`}
          title={`Remove ${label}`}
          disabled={item.pending}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>
      {open && (
        <div
          id={contentId}
          className="relative min-w-0 space-y-4 pr-3 pb-8 pl-9"
        >
          {item.traceId ? (
            payload.error ? (
              <ErrorState error={payload.error} onRetry={payload.refresh} />
            ) : !payload.data ? (
              <LoadingState compact label="Loading trace evidence" />
            ) : (
              <div className="min-w-0">
                <PayloadSection label="Input">
                  <StructuredValueViewer
                    label="Input"
                    value={payload.data.input ?? null}
                    initialView="json"
                  />
                </PayloadSection>
                <PayloadSection label="Output">
                  <StructuredValueViewer
                    label="Output"
                    value={payload.data.output ?? null}
                    initialView="json"
                  />
                </PayloadSection>
              </div>
            )
          ) : (
            <CodeEditor
              label={`${label} sample`}
              language="json"
              showPrettify
              className="h-52"
              value={item.sample}
              readOnly={item.pending}
              onChange={onChange}
            />
          )}
          {(item.result || item.error) && (
            <InspectorSection label="Run result">
              <div
                aria-busy={item.pending || undefined}
                className={item.pending ? "blur-sm" : undefined}
              >
                {item.error && (
                  <Notice variant="error" role="alert">
                    {item.error}
                  </Notice>
                )}
                {item.result && (
                  <div aria-label="Scorer test result" role="status">
                    <StructuredValueViewer
                      label="Run result"
                      value={item.result as unknown as JsonValue}
                      initialView="json"
                    />
                  </div>
                )}
              </div>
            </InspectorSection>
          )}
        </div>
      )}
    </article>
  )
}
