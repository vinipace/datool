"use client"

import { useState } from "react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Select } from "@/components/ui/select"
import { collectionTable } from "@/components/tracer/collection-table-styles"
import type { AgentUsage, AgentUsageRow } from "@/src/lib/build/integrations"
import { formatCredits } from "@/src/lib/execution-credits"
const number = (value: number) => new Intl.NumberFormat("en-US").format(value)
export function AgentUsageDetails({ usage }: { usage: AgentUsage }) {
  const [group, setGroup] = useState("agents")
  const rows = group === "agents" ? usage.agents : usage.conversations
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>Agent usage</CardTitle>
          <Select
            aria-label="Group agent usage"
            value={group}
            onChange={(event) => setGroup(event.target.value)}
            className="w-auto"
          >
            <option value="agents">By agent</option>
            <option value="conversations">By conversation</option>
          </Select>
        </div>
        <CardDescription>
          {new Date(usage.periodStart).toLocaleDateString("en-US", {
            timeZone: "UTC",
          })}{" "}
          –{" "}
          {new Date(usage.periodEnd).toLocaleDateString("en-US", {
            timeZone: "UTC",
          })}{" "}
          · {number(usage.totals.modelCalls)} model calls ·{" "}
          {number(usage.totals.integrationCalls)} app calls ·{" "}
          {number(usage.totals.inputTokens + usage.totals.outputTokens)}{" "}
          reported tokens
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-5">
        {!rows.length ? (
          <p className="py-6 text-center text-sm text-foreground-muted">
            Agent tokens and app calls appear here after your first run.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className={`${collectionTable.table} min-w-200`}>
              <thead className={collectionTable.head}>
                <tr>
                  {[
                    group === "agents" ? "Agent" : "Conversation",
                    "Input",
                    "Output",
                    "Cached input",
                    "Reasoning",
                    "App calls",
                    "App cost",
                  ].map((label) => (
                    <th
                      key={label}
                      scope="col"
                      className={`${collectionTable.heading} first:w-56`}
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <UsageRow
                    key={`${row.projectId}:${row.agentId}:${row.conversationId}`}
                    row={row}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {usage.totals.missingTokenCalls > 0 && (
          <p className="text-sm text-foreground-muted">
            {number(usage.totals.missingTokenCalls)} model calls have incomplete
            token reports; totals include only reported tokens.
          </p>
        )}
        {usage.totals.pendingCalls > 0 && (
          <p className="text-sm text-foreground-muted">
            {number(usage.totals.pendingCalls)} calls are in progress or have an
            uncertain outcome.
          </p>
        )}
        <p className="text-xs leading-relaxed text-foreground-muted">
          Cached input and reasoning are included in input and output totals.
          App cost uses the configured per-call rate. Customer model keys are
          billed by the provider. Showing up to {usage.rowLimit} recently active{" "}
          {group}; totals include all activity. Tracking starts when this
          feature is enabled.
        </p>
      </CardContent>
    </Card>
  )
}
function UsageRow({ row }: { row: AgentUsageRow }) {
  return (
    <tr className={`${collectionTable.row} cursor-default`}>
      <td className={collectionTable.cell}>
        <div className="max-w-64 font-medium break-words">
          {row.conversationId || row.agentName}
        </div>
        <div className="text-xs text-foreground-muted">
          {row.projectName}
          {row.conversationId ? ` · ${row.agentName}` : ""}
        </div>
      </td>
      {[
        row.inputTokens,
        row.outputTokens,
        row.cachedInputTokens,
        row.reasoningTokens,
        row.integrationCalls,
      ].map((value, index) => (
        <td key={index} className={`${collectionTable.cell} tabular-nums`}>
          {number(value)}
        </td>
      ))}
      <td className={`${collectionTable.cell} tabular-nums`}>
        {formatCredits(row.integrationCostUsd)}
      </td>
    </tr>
  )
}
