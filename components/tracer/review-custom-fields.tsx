"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import {
  customFieldSource,
  customFieldValue,
  outputHash,
} from "@/src/lib/tracer/review-annotations"
import { tracerApi } from "./api"
import { useRemote } from "./hooks"
import { fieldRegistry } from "./custom-field-registry"
import {
  ColumnEditor,
  ComputedColumnDetails,
  ComputedValue,
} from "./eval-computed-columns"
import { useComputedColumns, useColumnValues } from "./use-computed-columns"
import { useReviewAnnotations } from "./review-annotation-context"
import { AnnotatableValue } from "./review-annotations"

/** Reuse the trace table's field selection and browser sandbox in the player. */
export function ReviewCustomFields({ traceId }: { traceId: string }) {
  const context = useReviewAnnotations()!
  const load = React.useCallback(
    (signal: AbortSignal) => tracerApi.traces.payload(traceId, signal),
    [traceId]
  )
  const state = useRemote(load, [traceId], {
    intervalMs: 3000,
    shouldPoll: (trace) => trace?.status === "running",
  })
  const trace = state.data
  const rows = React.useMemo(
    () =>
      trace
        ? [
            {
              id: trace.id,
              trace,
              expectedOutput: null,
              datasetItemId: null,
              results: [],
            },
          ]
        : [],
    [trace]
  )
  const computed = useComputedColumns("traces", rows)
  // Linked comments must open their fields even in another browser with no saved selection.
  const referenced = context.annotations.flatMap((entry) =>
    entry.reference.customField ? [entry.reference.customField] : []
  )
  const extra = fieldRegistry
    .resolve(referenced)
    .filter(
      (field) => !computed.columns.some((column) => column.id === field.id)
    )
  const extraCells = useColumnValues(rows, extra)
  const columns = [...computed.columns, ...extra]
  const source = trace ? JSON.stringify(customFieldSource(trace)) : null
  const [fingerprint, setFingerprint] = React.useState<{
    source: string
    hash: string
  } | null>(null)
  React.useEffect(() => {
    let cancelled = false
    if (source)
      void outputHash(JSON.parse(source)).then((hash) => {
        if (!cancelled) setFingerprint({ source, hash })
      })
    return () => {
      cancelled = true
    }
  }, [source])
  const sourceHash = fingerprint?.source === source ? fingerprint?.hash : null
  return (
    <>
      {state.error && (
        <Notice variant="error">
          Could not load custom fields.{" "}
          <Button size="sm" variant="outline" onClick={state.refresh}>
            Retry
          </Button>
        </Notice>
      )}
      {computed.storageError && (
        <Notice variant="error">{computed.storageError}</Notice>
      )}
      <ComputedColumnDetails
        key={
          context.focus?.reference.field === "custom"
            ? context.focus.nonce
            : "fields"
        }
        columns={columns}
        cells={{ ...computed.cells, ...extraCells }}
        rowId={traceId}
        onRemove={(id) => {
          void computed.update(
            computed.columns.filter((column) => column.id !== id)
          )
        }}
        action={
          <ColumnEditor
            addedFields={columns}
            borderless
            addLabel="Add custom field"
            rows={rows}
            onSave={(column) => computed.update([...computed.columns, column])}
          />
        }
        renderValue={(column, cell) => {
          const content = <ComputedValue format={column.format} cell={cell} />
          if (
            !trace ||
            !sourceHash ||
            cell?.value == null ||
            cell.error ||
            cell.value.length > 100000
          )
            return content
          return (
            <AnnotatableValue
              value={cell.value}
              target={{
                traceId,
                spanId: null,
                spanName: trace.name,
                field: "custom",
                customField: {
                  ...customFieldValue(column, cell.value),
                  sourceHash,
                },
              }}
              renderValue={() => content}
            />
          )
        }}
      />
    </>
  )
}
