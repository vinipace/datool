"use client"

import * as React from "react"
import { ArrowDownRight, Braces, Calendar, Equal, Link2 } from "lucide-react"
import type { DatasetItem, JsonValue } from "@/src/lib/tracer/contracts"
import type { LogTableSettings } from "@/src/lib/tracer/custom-views"
import { datasetFields, datasetFieldLabels } from "@/src/lib/tracer/dataset-schemas"
import { availableValueViews, isValueView, valueViews, valueViewLabels, type ValueView } from "@/src/lib/tracer/value-views"
import { StructuredValueView } from "@/components/ui/structured-value-view"
import { Notice } from "@/components/ui/notice"
import {
  LogRow,
  LogRowSelection,
  LogSelectAll,
  LogTable,
  LogTableBody,
} from "./log-table"
import { logTable } from "./log-table-styles"
import { LogTimestamp } from "./log-timestamp"
import { ColumnEditor, ComputedValue } from "./eval-computed-columns"
import type { useComputedColumns } from "./use-computed-columns"

const columns = [
  { id: "created", label: "Created", icon: Calendar, width: 185 },
  { id: "input", label: "Input", icon: ArrowDownRight, width: 260 },
  { id: "expectedOutput", label: "Expected", icon: Equal, width: 220 },
  { id: "metadata", label: "Metadata", icon: Braces, width: 200 },
  { id: "sourceTraceId", label: "Source trace", icon: Link2, width: 160 },
]

export function DatasetItemsTable({
  items,
  computed,
  checked,
  onCheck,
  selectedId,
  onSelect,
  filtered,
  datasetId,
  drafts,
  settings,
  settingsError,
  onSettingsChange,
  onFieldViewChange,
}: {
  items: DatasetItem[]
  computed: ReturnType<typeof useComputedColumns>
  checked: Set<string>
  onCheck: (checked: Set<string>) => void
  selectedId: string | null
  onSelect: (item: DatasetItem, target: HTMLElement) => void
  filtered: boolean
  datasetId: string
  drafts: Set<string>
  settings: LogTableSettings
  settingsError?: string
  onSettingsChange: React.Dispatch<React.SetStateAction<LogTableSettings>>
  onFieldViewChange: (field: string, view: ValueView) => void
}) {
  const tall = settings.view === "cards" || settings.rowHeight === "tall"
  const contentClass = tall ? logTable.tallContent : logTable.compactContent
  const renderValue = (value: JsonValue, field: string) => (
    <div className={`font-mono text-xs text-foreground-muted ${contentClass}`}>
      <StructuredValueView value={value} view={settings.fieldViews?.[field] ?? "json"} compact={!tall} />
    </div>
  )
  const count = items.filter((item) => checked.has(item.id)).length
  return (
    <>
      {computed.storageError || settingsError ? (
        <Notice variant="error" role="status" className="mb-2">
          {computed.storageError || settingsError}
        </Notice>
      ) : null}
      <LogTable
        fillHeight
        enableRowHeight
        settings={settings}
        onSettingsChange={onSettingsChange}
        displaySettings={[{
          label: "Field views",
          items: datasetFields.map(field => ({
            id: field,
            label: datasetFieldLabels[field],
            value: settings.fieldViews?.[field] ?? "json",
            options: valueViews.filter(view => view === settings.fieldViews?.[field] ||
              items.length === 0 || items.some(item => availableValueViews(item[field]).includes(view))
            ).map(view => ({ value: view, label: valueViewLabels[view] })),
            onChange: view => { if (isValueView(view)) onFieldViewChange(field, view) },
          })),
        }]}
        computedColumnStore={computed.store}
        actionColumnIds={["add-column"]}
        columnIds={[
          ...columns.map((column) => column.id),
          ...computed.columns.map((column) => `computed:${column.id}`),
          "add-column",
        ]}
        widths={[
          ...columns.map((column) => column.width),
          ...computed.columns.map(() => 240),
          160,
        ]}
        reorderable
        orderStorageKey={`datool:dataset:${datasetId}:columns`}
      >
        <thead className={logTable.head}>
          <tr>
            <th scope="col" className="px-3">
              <LogSelectAll
                checked={count > 0 && count === items.length}
                partial={count > 0 && count < items.length}
                disabled={!items.length}
                label="Select all loaded dataset rows"
                onChange={() =>
                  onCheck(
                    count === items.length
                      ? new Set()
                      : new Set(items.map((item) => item.id))
                  )
                }
              />
            </th>
            {columns.map(({ id, label, icon: Icon }) => (
              <th
                key={id}
                scope="col"
                aria-label={label}
                className={logTable.heading}
              >
                <span className="flex items-center gap-2">
                  <Icon className="size-3.5" />
                  {label}
                </span>
              </th>
            ))}
            {computed.columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                aria-label={column.name}
                className={logTable.heading}
              >
                <ColumnEditor
                  resource="dataset"
                  column={column}
                  addedFields={computed.columns}
                  rows={items}
                  onSave={(next) =>
                    computed.update(
                      computed.columns.map((current) =>
                        current.id === next.id ? next : current
                      )
                    )
                  }
                  onDelete={() =>
                    computed.update(
                      computed.columns.filter(
                        (current) => current.id !== column.id
                      )
                    )
                  }
                />
              </th>
            ))}
            <th
              scope="col"
              aria-label="Add column"
              className={logTable.heading}
            >
              <ColumnEditor
                borderless
                resource="dataset"
                addedFields={computed.columns}
                rows={items}
                onSave={(column) =>
                  computed.update([...computed.columns, column])
                }
              />
            </th>
          </tr>
        </thead>
        <LogTableBody
          rows={items}
          estimatedRowHeight={tall ? 120 : 42}
          empty={
            <tr>
              <td
                colSpan={7 + computed.columns.length}
                className="py-12 text-center text-sm text-foreground-muted"
              >
                {filtered
                  ? "No matching rows. Try another filter."
                  : "No rows yet. Add a row or import your examples."}
              </td>
            </tr>
          }
        >
          {(item, index) => (
            <LogRow
              key={item.id}
              active={selectedId === item.id}
              checked={checked.has(item.id)}
              tabIndex={0}
              aria-label={`Open dataset row ${index + 1}`}
              onClick={(event) => {
                if ((event.target as HTMLElement).closest("summary, button, a, input")) return
                onSelect(item, event.currentTarget)
              }}
              onKeyDown={(event) => {
                if (
                  event.target === event.currentTarget &&
                  (event.key === "Enter" || event.key === " ")
                ) {
                  event.preventDefault()
                  onSelect(item, event.currentTarget)
                }
              }}
            >
              <LogRowSelection
                index={index}
                checked={checked.has(item.id)}
                label={`Select row ${index + 1}`}
                onChange={() => {
                  const next = new Set(checked)
                  if (next.has(item.id)) next.delete(item.id)
                  else next.add(item.id)
                  onCheck(next)
                }}
              />
              <td className={logTable.cell}>
                {drafts.has(item.id) ? (
                  <span className="text-sm text-foreground-secondary">
                    Unsaved row
                  </span>
                ) : (
                  <LogTimestamp value={item.createdAt} />
                )}
              </td>
              <td className={logTable.cell}>{renderValue(item.input, "input")}</td>
              <td className={logTable.cell}>
                {renderValue(item.expectedOutput, "expectedOutput")}
              </td>
              <td className={logTable.cell}>{renderValue(item.metadata, "metadata")}</td>
              <td className={logTable.cell}>
                <span
                  className={`block font-mono text-xs text-foreground-muted ${contentClass}`}
                >
                  {item.sourceTraceId ?? "—"}
                </span>
              </td>
              {computed.columns.map((column) => (
                <td key={column.id} className={logTable.cell}>
                  <div className={contentClass}>
                    <ComputedValue
                      cell={computed.cells[column.id]?.[item.id]}
                      format={column.format}
                    />
                  </div>
                </td>
              ))}
              <td className={logTable.cell} />
            </LogRow>
          )}
        </LogTableBody>
      </LogTable>
    </>
  )
}
