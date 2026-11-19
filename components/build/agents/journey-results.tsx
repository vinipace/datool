import Image from "next/image"
import type { JourneyResult } from "@/src/lib/build/agent-journey"
import { ExecutionStatus } from "@/components/ui/execution-status"

export function JourneyResults({ result }: { result: JourneyResult }) {
  return (
    <section
      aria-label="Customer journey results"
      className="space-y-3 border-b border-border px-4 py-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{result.name}</h3>
        <ExecutionStatus
          status={result.status === "passed" ? "completed" : "error"}
          label={
            result.status === "passed"
              ? "Interactions passed"
              : result.status === "failed"
                ? "Interactions failed"
                : "Could not run interactions"
          }
        />
      </div>
      <p className="text-xs text-foreground-muted">
        Saved version {result.agentRevision} · {result.width}px preview
        {result.locale ? ` · ${result.locale}` : ""}
      </p>
      <ol className="space-y-2">
        {result.steps.map((step, index) => (
          <li key={index} className="space-y-1 text-xs">
            <div className="flex items-start gap-2">
              <ExecutionStatus
                status={
                  step.status === "passed"
                    ? "completed"
                    : step.status === "skipped"
                      ? "skipped"
                      : "error"
                }
                label={step.status}
              />
              <span className="min-w-0 break-words">{step.name}</span>
            </div>
            {step.error ? (
              <p className="break-words text-destructive">{step.error}</p>
            ) : null}
          </li>
        ))}
      </ol>
      {result.screenshot ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-foreground-muted">
            Failure screenshot
          </summary>
          <Image
            unoptimized
            src={result.screenshot}
            alt="Widget at the failed test assertion"
            width={result.width}
            height={900}
            className="mt-2 max-h-80 w-auto max-w-full rounded-md border border-border object-contain"
          />
        </details>
      ) : null}
    </section>
  )
}
