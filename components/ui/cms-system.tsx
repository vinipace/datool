"use client"

import { useId, type ReactNode } from "react"
import { Pill, ReactSelect, Table } from "@payloadcms/ui"
import { ChevronDown } from "lucide-react"
import type { Column } from "payload"
import { DashboardTimeChart } from "@/components/tracer/dashboard-time-chart"
import { systemUsageChart } from "@/src/lib/system-usage-chart"
import { formatCount, type UsageMonth } from "@/src/lib/system-overview"
import styles from "./cms-system.module.css"
import "./cms-chart.css"

function SelectIndicator() {
  return (
    <span aria-hidden="true">
      <ChevronDown size={16} />
    </span>
  )
}

/** Keep Payload's select styling with a labelled input and decorative chevron. */
export function SystemSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string
  value: string
  options: { label: string; value: string }[]
  disabled: boolean
  onChange: (value: string) => void
}) {
  const id = useId()
  return (
    <div className="field-type select">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <ReactSelect
        inputId={id}
        value={options.find((option) => option.value === value)}
        options={options}
        isClearable={false}
        disabled={disabled}
        components={{ DropdownIndicator: SelectIndicator }}
        onChange={(option) => {
          if (option && !Array.isArray(option)) onChange(String(option.value))
        }}
      />
    </div>
  )
}

export function SystemStats({
  items,
}: {
  items: { label: string; value: number | null }[]
}) {
  return (
    <div className={styles.stats}>
      {items.map((item) => (
        <div className={styles.stat} key={item.label}>
          <span className={styles.muted}>{item.label}</span>
          <strong>{formatCount(item.value)}</strong>
        </div>
      ))}
    </div>
  )
}

export function SubscriptionStatus({ status }: { status: string }) {
  const tone =
    status === "active"
      ? "success"
      : status === "trialing"
        ? "light"
        : ["past_due", "incomplete"].includes(status)
          ? "warning"
          : ["unpaid", "canceled", "incomplete_expired"].includes(status)
            ? "error"
            : "light-gray"
  return (
    <Pill pillStyle={tone}>
      {status === "none" ? "No subscription" : status.replaceAll("_", " ")}
    </Pill>
  )
}

export function SystemTable<T extends { id: string }>({
  rows,
  columns,
  empty = "No organizations match these filters.",
}: {
  rows: T[]
  columns: { key: string; label: string; cell: (row: T) => ReactNode }[]
  empty?: string
}) {
  if (!rows.length)
    return (
      <div className={styles.empty} role="status">
        {empty}
      </div>
    )
  const tableColumns: Column[] = columns.map((column) => ({
    accessor: column.key,
    active: true,
    Heading: column.label,
    field: { name: column.key, type: "text" },
    renderedCells: rows.map(column.cell),
  }))
  return (
    <div className={styles.table}>
      <Table appearance="condensed" data={rows} columns={tableColumns} />
    </div>
  )
}

export function UsageQuota({
  used,
  limit,
}: {
  used: number | null
  limit: number | null
}) {
  if (used === null || !limit) return <span className={styles.muted}>—</span>
  const percent = Math.round((used / limit) * 100)
  return (
    <div className={styles.quota}>
      <span>
        {percent}% of {formatCount(limit)}
      </span>
      <progress
        aria-label="Billing quota used"
        max={100}
        value={Math.min(100, percent)}
      />
    </div>
  )
}

export function UsageHistory({
  months,
  capturedAt,
}: {
  months: UsageMonth[]
  capturedAt: string
}) {
  const chart = systemUsageChart(months, capturedAt)
  return (
    <section className={styles.section} aria-label="Monthly usage history">
      <h2>Monthly usage</h2>
      <p className={styles.muted}>
        Retained traces + spans by start month (UTC), including activity before
        billing was enabled. Deleted records are excluded. Hover or focus the
        chart for details.
      </p>
      <div className="cms-chart">
        <DashboardTimeChart
          {...chart}
          summary={null}
          missingLabel="Not recorded"
        />
      </div>
    </section>
  )
}
