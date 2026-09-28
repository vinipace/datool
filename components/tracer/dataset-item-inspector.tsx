"use client"

import * as React from "react"
import { StructuredValueView } from "@/components/ui/structured-value-view"
import Link from "next/link"
import {
  ArrowDown,
  ArrowDownRight,
  ArrowUp,
  Braces,
  Clock3,
  Code2,
  ListChecks,
  TextCursorInput,
  Equal,
  ExternalLink,
  Trash2,
  X,
} from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { InspectorSection } from "@/components/ui/inspector-section"
import { InspectorTabs } from "@/components/ui/inspector-tabs"
import { datasetItemViewTrace, datasetItemViewInput } from "@/src/lib/tracer/dataset-item-view"
import { ReactTraceViews } from "./react-trace-views"
import { DatasetItemRuns } from "./dataset-item-runs"
import { Notice } from "@/components/ui/notice"
import { StructuredValueEditor } from "@/components/ui/structured-value-editor"
import { DeferredValue } from "@/components/ui/deferred-value"
import type { ValueView } from "@/src/lib/tracer/value-views"
import type {
  DatasetFieldSchemas,
  DatasetItem,
  DatasetItemField,
  DatasetItemPreview,
} from "@/src/lib/tracer/contracts"
import {
  datasetFieldErrors,
  datasetFieldLabels,
  datasetFields,
} from "@/src/lib/tracer/dataset-schemas"
import {
  parseValueDocument,
  type ItemDraft,
} from "@/src/lib/tracer/dataset-editor"
import { formatDate, formatRelative } from "./format"
import { useWorkspaceHref } from "./workspace-path"

type ItemTab = "form" | "runs" | "views"

const icons = { input: ArrowDownRight, expectedOutput: Equal, metadata: Braces }

export function DatasetItemInspector({
  item,
  draft,
  onDraftChange,
  schemas,
  fieldViews,
  onFieldViewChange,
  onRetry,
  onDelete,
  onClose,
  onPrevious,
  onNext,
  saving,
  isNew,
  error,
  customColumnDetails,
  onLoadField,
  loadingField,
  fieldErrors,
}: {
  item: DatasetItemPreview
  draft: ItemDraft
  onDraftChange: (draft: ItemDraft) => void
  schemas: DatasetFieldSchemas
  fieldViews?: Record<string, ValueView>
  onFieldViewChange: (field: string, view: ValueView) => void
  onRetry: () => void
  onDelete: () => void
  onClose: () => void
  onPrevious?: () => void
  onNext?: () => void
  saving: boolean
  isNew: boolean
  error?: string
  customColumnDetails?: React.ReactNode
  onLoadField?: (field: DatasetItemField) => void
  loadingField?: DatasetItemField | null
  fieldErrors?: Partial<Record<DatasetItemField, string>>
}) {
  const workspaceHref = useWorkspaceHref()
  const [activeTab, setActiveTab] = React.useState<ItemTab>("form")
  const form = React.useRef<HTMLDivElement>(null)
  const previousOmissions = React.useRef(item.omittedFields)
  React.useEffect(() => {
    for (const field of datasetFields) {
      if (previousOmissions.current?.[field] && !item.omittedFields?.[field]) {
        form.current?.querySelector<HTMLElement>(`[data-dataset-field="${field}"]`)?.focus()
      }
    }
    previousOmissions.current = item.omittedFields
  }, [item.omittedFields])
  const deferred = (field: DatasetItemField, label: string) => {
    const omitted = item.omittedFields?.[field]
    return omitted && <DeferredValue label={label} {...omitted} onLoad={() => onLoadField?.(field)} loading={loadingField === field} disabled={!onLoadField || Boolean(loadingField)} error={fieldErrors?.[field]} />
  }
  return (
    <aside
      aria-label="Dataset row inspector"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-3">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous row"
          disabled={!onPrevious}
          onClick={onPrevious}
        >
          <ArrowUp className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next row"
          disabled={!onNext}
          onClick={onNext}
        >
          <ArrowDown className="size-4" />
        </Button>
        <h2 className="ml-1 min-w-0 flex-1 truncate text-sm">
          Dataset row{" "}
          <span className="ml-2 font-mono text-xs text-foreground-muted">
            {item.id.slice(-8)}
          </span>
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={isNew ? "Discard row" : "Delete row"}
          disabled={saving}
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close row"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="shrink-0 border-b border-border">
        <InspectorTabs<ItemTab>
          label="Dataset row inspector sections"
          value={activeTab}
          onValueChange={setActiveTab}
          tabs={[
            { value: "form", label: "Form", icon: TextCursorInput },
            { value: "runs", label: "Runs", icon: ListChecks },
            { value: "views", label: "Views", icon: Code2 },
          ]}
        />
      </div>
      {error && (
        <Notice variant="error" role="alert" className="mx-4 my-3 shrink-0">
          {error} Your edits are still here.
          <Button
            size="sm"
            variant="outline"
            onClick={onRetry}
            className="mt-2"
          >
            Retry save
          </Button>
        </Notice>
      )}
      {activeTab === "runs" ? (
        isNew ? (
          <p className="p-4 text-sm text-foreground-muted">
            Save this row to see its runs.
          </p>
        ) : (
          <DatasetItemRuns key={item.id} itemId={item.id} />
        )
      ) : activeTab === "views" ? (
        item.omittedFields ? <p className="p-4 text-sm text-foreground-muted">Load the large fields in Form to preview this row in Views.</p> : <DatasetItemViews item={item} draft={draft} isNew={isNew} />
      ) : (
        <div ref={form} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-5">
          {datasetFields.map((field) => {
            const Icon = icons[field]
            if (item.omittedFields?.[field]) return (
              <InspectorSection key={field} label={datasetFieldLabels[field]} icon={<Icon className="size-3.5" />}>
                {deferred(field, datasetFieldLabels[field])}
              </InspectorSection>
            )
            let warnings: string[] = []
            let metadataError = ""
            try {
              const value = parseValueDocument(draft[field])
              if (
                field === "metadata" &&
                (!value || typeof value !== "object" || Array.isArray(value))
              ) {
                metadataError = "Metadata must be a JSON object."
              } else {
                warnings = datasetFieldErrors(schemas[field]?.schema, value)
              }
            } catch {
              /* The editor displays syntax errors. */
            }
            return (
              <InspectorSection
                key={field}
                label={datasetFieldLabels[field]}
                icon={<Icon className="size-3.5" />}
              >
                <div data-dataset-field={field} tabIndex={-1} role="group" aria-label={`${datasetFieldLabels[field]} field`}>
                  <StructuredValueEditor
                    disabled={Boolean(loadingField)}
                    autoSize={draft[field].text.length <= 16 * 1024}
                    height="h-80"
                    label={`Row ${datasetFieldLabels[field]}`}
                    value={draft[field]}
                    view={fieldViews?.[field] ?? "json"}
                    onViewChange={(view) => onFieldViewChange(field, view)}
                    onChange={(value) =>
                      onDraftChange({ ...draft, [field]: value })
                    }
                    schema={schemas[field]?.schema}
                  />
                </div>
                {metadataError ? (
                  <p className="mt-2 text-xs text-destructive" role="alert">
                    {metadataError}
                  </p>
                ) : warnings.length > 0 ? (
                  <p
                    className={`mt-2 text-xs ${schemas[field]?.enforced ? "text-destructive" : "text-foreground-muted"}`}
                    role="status"
                  >
                    {schemas[field]?.enforced
                      ? "Schema validation"
                      : "Schema suggestion"}
                    : {warnings.join("; ")}
                  </p>
                ) : null}
              </InspectorSection>
            )
          })}
          {customColumnDetails}
          {item.omittedFields?.sourceSpanEvidence ? (
            <InspectorSection label="Captured invocation">{deferred("sourceSpanEvidence", "Captured invocation")}</InspectorSection>
          ) : item.sourceSpanEvidence && (
            <InspectorSection label="Captured invocation">
              <p className="mb-2 text-xs text-foreground-muted">
                Observed output is unreviewed evidence. Editing case input maps
                app variables without changing the captured scoring evidence.
              </p>
              <StructuredValueView
                value={{
                  input: item.sourceSpanEvidence.input,
                  observedOutput:
                    item.observedOutput ?? item.sourceSpanEvidence.output,
                }}
                view="json"
              />
            </InspectorSection>
          )}
          <InspectorSection
            label="Details"
            icon={<Clock3 className="size-3.5" />}
          >
            <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-3 text-xs">
              <dt className="text-foreground-muted">Created</dt>
              <dd title={formatDate(item.createdAt)}>
                {isNew ? "Not saved yet" : formatRelative(item.createdAt)}
              </dd>
              <dt className="text-foreground-muted">Updated</dt>
              <dd title={formatDate(item.updatedAt)}>
                {isNew ? "—" : formatRelative(item.updatedAt)}
              </dd>
              <dt className="text-foreground-muted">Source trace</dt>
              <dd className="grid gap-2">
                <Input
                  aria-label="Source trace ID"
                  placeholder="Optional trace ID"
                  className="h-8 font-mono text-xs"
                  value={draft.sourceTraceId}
                  disabled={Boolean(loadingField)}
                  readOnly={Boolean(item.sourceSpanId)}
                  onChange={(event) =>
                    onDraftChange({
                      ...draft,
                      sourceTraceId: event.target.value,
                    })
                  }
                />
                {item.sourceTraceId ? (
                  <Link
                    className="inline-flex items-center gap-1 break-all hover:underline"
                    href={workspaceHref(
                      `/traces/${encodeURIComponent(item.sourceTraceId)}${item.sourceSpanId ? `?span=${encodeURIComponent(item.sourceSpanId)}` : ""}`
                    )}
                  >
                    {item.sourceSpanId
                      ? `${item.sourceTraceId} / ${item.sourceSpanId}`
                      : item.sourceTraceId}
                    <ExternalLink className="size-3" />
                  </Link>
                ) : (
                  "—"
                )}
              </dd>
            </dl>
          </InspectorSection>
        </div>
      )}
    </aside>
  )
}

function DatasetItemViews({
  item,
  draft,
  isNew,
}: {
  item: DatasetItem
  draft: ItemDraft
  isNew: boolean
}) {
  let trace
  try {
    trace = datasetItemViewTrace(item, draft)
  } catch {
    return (
      <Notice variant="error" role="alert" className="m-4">
        Fix invalid row values in Form to preview this view.
      </Notice>
    )
  }
  return <ReactTraceViews trace={trace} objectInput={datasetItemViewInput(item, draft, isNew)} source={isNew ? null : { kind: "dataset-item", id: item.id }} />
}
