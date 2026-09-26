"use client"

import * as React from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Combobox } from "@/components/ui/combobox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Notice } from "@/components/ui/notice"
import { Textarea } from "@/components/ui/textarea"
import { StructuredValueView } from "@/components/ui/structured-value-view"
import { useWorkspaceHref } from "./workspace-path"
import type {
  PromoteSpansInput,
  SpanPromotionResult,
} from "@/src/lib/tracer/span-promotion"
import { tracerApi } from "./api"
import { CollectionPagination } from "./collection-pagination"
import { ErrorState, LoadingState } from "./primitives"
import { useCollectionPages } from "./use-collection-pages"

export function SpanPromotionDialog({
  traceId,
  spanId,
  onClose,
}: {
  traceId: string
  spanId: string
  onClose: () => void
}) {
  const href = useWorkspaceHref()
  const datasets = useCollectionPages(tracerApi.datasets.list, "", 60_000)
  const [datasetId, setDatasetId] = React.useState<string | null>(null)
  const [mapping, setMapping] = React.useState(false)
  const [mappedInput, setMappedInput] = React.useState("{}")
  const [copyObservedOutput, setCopyObservedOutput] = React.useState(false)
  const [proposal, setProposal] = React.useState<SpanPromotionResult | null>(
    null
  )
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const [saved, setSaved] = React.useState(false)
  function change(action: () => void) {
    action()
    setProposal(null)
    setError("")
  }
  async function submit(save: boolean) {
    if (!datasetId) return
    setBusy(true)
    setError("")
    try {
      const input: PromoteSpansInput = {
        datasetId,
        preview: !save,
        ...(save && proposal
          ? { expectedEvidenceHash: proposal.evidenceHash }
          : {}),
        spans: [
          {
            traceId,
            spanId,
            copyObservedOutput,
            ...(mapping ? { mappedInput: JSON.parse(mappedInput) } : {}),
          },
        ],
      }
      const result = await tracerApi.datasets.promoteSpans(input)
      setProposal(result)
      if (save) setSaved(true)
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to promote this span."
      )
    } finally {
      setBusy(false)
    }
  }
  const item = proposal?.cases[0]
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create case from span</DialogTitle>
          <DialogDescription>
            Capture this invocation and its descendants. Observed output is
            unreviewed evidence; the reference answer stays empty unless you
            explicitly copy it.
          </DialogDescription>
        </DialogHeader>
        {saved ? (
          <Notice variant="success">
            Case saved.{" "}
            <Link
              className="underline"
              href={href(`/datasets/${encodeURIComponent(datasetId!)}`)}
            >
              Open dataset
            </Link>
          </Notice>
        ) : (
          <>
            {datasets.isLoading && (
              <LoadingState compact label="Loading datasets" />
            )}
            {datasets.error && (
              <ErrorState error={datasets.error} onRetry={datasets.refresh} />
            )}
            {!datasets.isLoading &&
              !datasets.error &&
              !datasets.items.length && (
                <Notice>
                  Create a dataset first.{" "}
                  <Link className="underline" href={href("/datasets")}>
                    Open datasets
                  </Link>
                </Notice>
              )}
            <Combobox
              label="Dataset"
              placeholder="Find a dataset"
              value={datasetId}
              onValueChange={(value) => change(() => setDatasetId(value))}
              options={datasets.items.map((dataset) => ({
                value: dataset.id,
                label: dataset.name,
              }))}
              disabled={busy || !datasets.items.length}
            />
            <CollectionPagination {...datasets} />
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={mapping}
                disabled={busy}
                onChange={(event) =>
                  change(() => setMapping(event.target.checked))
                }
              />
              Map input to app variables
            </label>
            {mapping && (
              <div className="grid gap-2">
                <p className="text-sm text-foreground-muted">
                  Enter the connected app&apos;s input JSON explicitly. The
                  original captured input remains available for scoring and
                  inspection.
                </p>
                <Textarea
                  aria-label="Mapped app input JSON"
                  value={mappedInput}
                  disabled={busy}
                  onChange={(event) =>
                    change(() => setMappedInput(event.target.value))
                  }
                  className="min-h-24 font-mono"
                />
              </div>
            )}
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={copyObservedOutput}
                disabled={busy}
                onChange={(event) =>
                  change(() => setCopyObservedOutput(event.target.checked))
                }
              />
              Use observed output as the reference answer
            </label>
            {copyObservedOutput && (
              <Notice variant="warning">
                Only use this after reviewing the observation. Copying it does
                not establish correctness.
              </Notice>
            )}
            {item && (
              <div
                className="grid min-w-0 gap-4 sm:grid-cols-2"
                aria-label="Proposed case"
              >
                {(
                  [
                    ["Case input", item.input],
                    ...(mapping
                      ? [
                          [
                            "Original captured input",
                            item.sourceSpanEvidence.input,
                          ],
                        ]
                      : []),
                    ["Observed output (unreviewed)", item.observedOutput],
                    ["Expected output", item.expectedOutput ?? null],
                  ] as const
                ).map(([label, value]) => (
                  <section key={String(label)} className="min-w-0">
                    <h3 className="mb-2 text-sm font-medium">
                      {String(label)}
                    </h3>
                    <div className="max-h-44 overflow-auto">
                      <StructuredValueView value={value} view="json" />
                    </div>
                  </section>
                ))}
                <p className="text-xs break-all text-foreground-muted">
                  Source: {traceId} / {spanId} ·{" "}
                  {item.sourceSpanEvidence.spans.length} evidence spans ·{" "}
                  {item.sourceSpanEvidence.startedAt}
                </p>
              </div>
            )}
            {error && (
              <Notice variant="error" role="alert">
                {error}
              </Notice>
            )}
          </>
        )}
        <DialogFooter className="sticky bottom-0 bg-background pt-3">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {saved ? "Done" : "Cancel"}
          </Button>
          {!saved && (
            <Button
              disabled={!datasetId}
              loading={busy}
              onClick={() => void submit(Boolean(proposal))}
            >
              {proposal ? "Save case" : "Preview case"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
