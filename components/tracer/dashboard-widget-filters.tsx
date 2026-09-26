"use client"

import { useCallback, useContext, useState } from "react"
import { Bot, GitBranch, GitCompareArrows, Workflow, X } from "lucide-react"
import { Combobox, ComboboxMultiple } from "@/components/ui/combobox"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import type { InvocationSelection } from "@/src/lib/semantic/group-filter"
import { semanticQuerySchema } from "@/src/lib/semantic/query"
import type { SemanticResult } from "@/src/lib/semantic/result"
import type { DashboardWidget } from "@/src/lib/tracer/dashboards"
import {
  groupKey,
  versionKey,
  versionLabel,
} from "@/src/lib/tracer/dashboard-filters"
import { dashboardRequest } from "./dashboard-utils"
import { useRemote } from "./hooks"
import { DashboardQueryFilters } from "./dashboard-query-filters"
import { DashboardFilterScopeContext } from "./dashboard-catalog-context"

export function DashboardWidgetFilters({
  widget,
  onChange,
}: {
  widget: DashboardWidget
  onChange: (widget: DashboardWidget) => void
}) {
  const scope = useContext(DashboardFilterScopeContext)
  const model = widget.query.measures[0].split(".")[0]
  const supported = [
    "logs",
    "spans",
    "traces",
    "agents",
    "workflows",
    "evalResults",
    "evalRuns",
  ].includes(model)
  const selections = widget.groups ?? []
  const [addedGroups, setAddedGroups] = useState<string[]>([])
  const visibleGroups = new Set([
    ...addedGroups,
    ...selections.map((group) => group.type),
  ])
  const [from, to] = scope
    ? [scope.from, scope.to]
    : widget.query.timeDimensions[0].dateRange
  const timezone = scope?.timezone ?? widget.query.timezone
  const source = JSON.stringify({
    from,
    to,
    timezone,
    saved: ["evalResults", "evalRuns"].includes(model),
  })
  const load = useCallback(
    async (signal: AbortSignal) => {
      const { from, to, timezone, saved } = JSON.parse(source) as {
        from: string
        to: string
        timezone: string
        saved: boolean
      }
      const results = await dashboardRequest<SemanticResult[]>(
        "/api/metrics/batch",
        "POST",
        {
          queries: ["agents", "workflows"].map((name) =>
            semanticQuerySchema.parse({
              measures: [
                saved ? "evalResults.executionCount" : `${name}.count`,
              ],
              dimensions: saved
                ? ["evalResults.groupName", "evalResults.groupVersion"]
                : [`${name}.name`, `${name}.version`],
              ...(saved
                ? {
                    filters: [
                      {
                        member: "evalResults.groupType",
                        operator: "equals",
                        values: [name === "agents" ? "agent" : "workflow"],
                      },
                    ],
                  }
                : {}),
              timeDimensions: [
                {
                  dimension: saved
                    ? "evalResults.completedAt"
                    : `${name}.startedAt`,
                  dateRange: [from, to],
                },
              ],
              timezone,
              limit: 5000,
              total: true,
              order: [
                [saved ? "evalResults.groupName" : `${name}.name`, "asc"],
                [saved ? "evalResults.groupVersion" : `${name}.version`, "asc"],
              ],
            })
          ),
        },
        { signal }
      )
      return { source, results }
    },
    [source]
  )
  const state = useRemote(load, [], {
    enabled: supported && visibleGroups.size > 0,
  })
  const groupsLoading =
    state.isLoading ||
    (visibleGroups.size > 0 && state.data?.source !== source && !state.error)
  const results = state.data?.source === source ? state.data.results : []
  const available = new Map<string, InvocationSelection>()
  results.forEach((result, index) => {
    const name = index === 0 ? "agents" : "workflows"
    const type = index === 0 ? "agent" : "workflow"
    result.data.forEach((row) => {
      const groupName =
        row[
          ["evalResults", "evalRuns"].includes(model)
            ? "evalResults.groupName"
            : `${name}.name`
        ]
      const version =
        row[
          ["evalResults", "evalRuns"].includes(model)
            ? "evalResults.groupVersion"
            : `${name}.version`
        ]
      if (
        typeof groupName !== "string" ||
        (version !== null && typeof version !== "string")
      )
        return
      const group = { type, name: groupName } as InvocationSelection
      const key = groupKey(group)
      const entry = available.get(key) ?? { ...group, versions: [] }
      if (!entry.versions!.includes(version)) entry.versions!.push(version)
      available.set(key, entry)
    })
  })
  // Keep persisted selections editable even when they have no data in this window.
  selections.forEach((group) => {
    const entry = available.get(groupKey(group)) ?? { ...group, versions: [] }
    entry.versions = [
      ...new Set([...(entry.versions ?? []), ...(group.versions ?? [])]),
    ]
    available.set(groupKey(group), entry)
  })
  const all = [...available.values()]
  const selectedKeys = new Set(selections.map(groupKey))
  const versionOptions = all
    .filter((group) => selectedKeys.has(groupKey(group)))
    .flatMap(
      (group) =>
        group.versions?.map((version) => ({
          value: versionKey(group, version),
          label: `${group.name} · ${versionLabel(version)}`,
        })) ?? []
    )

  function changeGroups(groups: InvocationSelection[]) {
    const compare = groups.find(
      (group) =>
        widget.compare &&
        groupKey(group) === groupKey(widget.compare) &&
        (group.versions?.length ?? 0) >= 2
    )
    onChange({
      ...widget,
      groups,
      compare: compare ? widget.compare : undefined,
      query: { ...widget.query, offset: 0 },
    })
  }

  return (
    <DashboardQueryFilters
      widget={widget}
      onChange={onChange}
      extraOptions={
        supported
          ? [
              ...(!visibleGroups.has("agent")
                ? [{ value: "agent", label: "Agents", icon: Bot }]
                : []),
              ...(!visibleGroups.has("workflow")
                ? [{ value: "workflow", label: "Workflows", icon: Workflow }]
                : []),
            ]
          : []
      }
      onExtraAdd={(type) => setAddedGroups((groups) => [...groups, type])}
    >
      {supported && (
        <>
          {state.error && visibleGroups.size > 0 && (
            <Notice variant="error" role="alert">
              Unable to load agents and workflows.
              <Button size="sm" variant="outline" onClick={state.refresh}>
                Retry filters
              </Button>
            </Notice>
          )}
          {(["agent", "workflow"] as const)
            .filter((type) => visibleGroups.has(type))
            .map((type) => {
              const label = type === "agent" ? "Agents" : "Workflows"
              return (
                <div key={type} className="space-y-2 text-xs font-medium">
                  <div className="flex items-center justify-between gap-2">
                    <span>{label}</span>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Remove ${label} filter`}
                      onClick={() => {
                        setAddedGroups((groups) =>
                          groups.filter((group) => group !== type)
                        )
                        changeGroups(
                          selections.filter((group) => group.type !== type)
                        )
                      }}
                    >
                      <X />
                    </Button>
                  </div>
                  <ComboboxMultiple
                    label={label}
                    icon={type === "agent" ? <Bot /> : <Workflow />}
                    placeholder={
                      state.isLoading
                        ? "Loading…"
                        : `All ${label.toLowerCase()}`
                    }
                    disabled={groupsLoading}
                    options={all
                      .filter((group) => group.type === type)
                      .map((group) => ({
                        value: groupKey(group),
                        label: group.name,
                      }))}
                    value={selections
                      .filter((group) => group.type === type)
                      .map(groupKey)}
                    onValueChange={(keys) =>
                      changeGroups([
                        ...selections.filter((group) => group.type !== type),
                        ...keys.map(
                          (key) =>
                            selections.find(
                              (group) => groupKey(group) === key
                            ) ?? { type, name: available.get(key)!.name }
                        ),
                      ])
                    }
                  />
                </div>
              )
            })}
          {selections.length > 0 && (
            <>
              <div className="space-y-2 text-xs font-medium">
                <span>Versions</span>
                <ComboboxMultiple
                  label="Versions"
                  icon={<GitBranch />}
                  placeholder="All versions"
                  options={versionOptions}
                  value={selections.flatMap(
                    (group) =>
                      group.versions?.map((version) =>
                        versionKey(group, version)
                      ) ?? []
                  )}
                  onValueChange={(keys) =>
                    changeGroups(
                      selections.map((group) => {
                        const versions = (
                          available.get(groupKey(group))?.versions ?? []
                        ).filter((version) =>
                          keys.includes(versionKey(group, version))
                        )
                        return {
                          ...group,
                          versions: versions.length ? versions : undefined,
                        }
                      })
                    )
                  }
                />
              </div>
              <div className="space-y-2 text-xs font-medium">
                <span>Compare versions</span>
                <Combobox
                  label="Compare versions"
                  icon={<GitCompareArrows />}
                  value={widget.compare ? groupKey(widget.compare) : ""}
                  options={[
                    { value: "", label: "No comparison" },
                    ...selections
                      .filter((group) => (group.versions?.length ?? 0) >= 2)
                      .map((group) => ({
                        value: groupKey(group),
                        label: group.name,
                      })),
                  ]}
                  onValueChange={(key) => {
                    const group = selections.find(
                      (item) => groupKey(item) === key
                    )
                    onChange({
                      ...widget,
                      compare: group
                        ? { type: group.type, name: group.name }
                        : undefined,
                      query: { ...widget.query, offset: 0 },
                    })
                  }}
                />
                {!selections.some(
                  (group) => (group.versions?.length ?? 0) >= 2
                ) && (
                  <p className="font-normal text-foreground-muted">
                    Select two or more versions of an agent or workflow to
                    compare.
                  </p>
                )}
              </div>
            </>
          )}
          {["logs", "spans", "traces"].includes(model) &&
            selections.length > 0 && (
              <p className="text-xs text-foreground-muted">
                Metrics include the full traces containing the selected agents
                and workflows.
              </p>
            )}
          {visibleGroups.size > 0 &&
            results.some(
              (result) => (result.meta.page.total ?? 0) > result.data.length
            ) && (
              <p role="status" className="text-xs text-foreground-muted">
                Showing the first 5,000 groups per type. Narrow the dashboard
                date range to find more.
              </p>
            )}
        </>
      )}
    </DashboardQueryFilters>
  )
}
