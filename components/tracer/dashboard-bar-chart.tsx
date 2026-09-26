"use client"

import Link from "next/link"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"

import type {
  SemanticDataRow,
  SemanticMemberAnnotation,
} from "@/src/lib/semantic/result"
import { dashboardChartStyle, dashboardBarColor } from "./dashboard-chart-style"
import { formatDashboardValue } from "./dashboard-utils"
import { DashboardGroupLabel } from "./dashboard-dimension-label"
import { dashboardGroupText } from "./dashboard-dimension-icon"

function BarRow({ href, children }: { href?: string; children: ReactNode }) {
  return href ? (
    <Button
      asChild
      variant="ghost"
      className="relative block h-auto w-full p-0 text-left font-normal whitespace-normal hover:underline"
    >
      <Link href={href} prefetch={false}>
        {children}
      </Link>
    </Button>
  ) : (
    <div className="relative">{children}</div>
  )
}

export function DashboardBarChart({
  title,
  rows,
  measure,
  dimensions,
  annotation,
  showGroupIcons = false,
  colorIndex = 0,
  hrefForRow,
}: {
  title: string
  rows: SemanticDataRow[]
  measure: string
  dimensions: string[]
  annotation?: SemanticMemberAnnotation
  showGroupIcons?: boolean
  colorIndex?: number
  hrefForRow?: (row: SemanticDataRow) => string | undefined
}) {
  const color = dashboardBarColor(colorIndex)
  const data = rows.map((row) => ({
    category: dashboardGroupText(dimensions, row),
    group: row,
    value: typeof row[measure] === "number" ? row[measure] : null,
    href: hrefForRow?.(row),
  }))
  const values = data.flatMap((row) => (row.value === null ? [] : [row.value]))
  const minimum = Math.min(0, ...values)
  const maximum = Math.max(0, ...values)
  const range = maximum - minimum || 1
  const zero = (-minimum / range) * 100

  return (
    <div className={dashboardChartStyle.bodyClassName}>
      <div
        role="group"
        aria-label={`${title} bar chart`}
        className="space-y-2.5 px-0 py-2"
      >
        {data.map((row, index) => (
          <BarRow key={`${row.category}:${index}`} href={row.href}>
            <div className="relative inset-0 z-15 flex items-center justify-between gap-3 px-2 py-2 text-xs">
              <span
                className="min-w-0 truncate wrap-break-word text-foreground"
                title={row.category}
              >
                {showGroupIcons ? (
                  <DashboardGroupLabel
                    dimensions={dimensions}
                    row={row.group}
                  />
                ) : (
                  row.category
                )}
              </span>
              <span className="shrink-0 font-medium tabular-nums">
                {formatDashboardValue(row.value, annotation)}
              </span>
            </div>

            <div
              className="absolute inset-0 z-5 overflow-hidden rounded-md bg-surface-row-hover"
              style={{
                opacity: (data.length - index) / data.length,
              }}
            ></div>
            <div
              className="absolute inset-0 z-10 overflow-hidden rounded-md"
              aria-hidden="true"
            >
              {minimum < 0 && (
                <span
                  className="absolute inset-y-0 border-l border-border"
                  style={{ left: `${zero}%` }}
                />
              )}
              {row.value !== null && (
                <span
                  className="absolute inset-y-0 rounded-md"
                  style={{
                    left: `${row.value < 0 ? ((row.value - minimum) / range) * 100 : zero}%`,
                    width: `${(Math.abs(row.value) / range) * 100}%`,
                    backgroundColor: color,
                    opacity: "var(--data-bar-opacity)",
                  }}
                />
              )}
            </div>
          </BarRow>
        ))}
      </div>
    </div>
  )
}
