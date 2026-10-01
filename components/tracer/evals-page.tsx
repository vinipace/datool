"use client"

import { PanelActionLabel } from "@/components/ui/panel-action-label"
import { ConnectedEvalButton } from "./connected-eval-button"

import * as React from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"

import {
  CollectionTableBody,
  CollectionTable,
  CollectionRow,
  CollectionRowSelection,
  CollectionSelectAll,
} from "./collection-table"
import { PercentageCell } from "./percentage-cell"
import { ResultIcon } from "./result-icon"
import { SpanKindIcon } from "./span-kind-icon"
import { collectionTable } from "./collection-table-styles"
import type {
  EvalRunSummary,
  EvalRunGroupSummary,
} from "@/src/lib/tracer/contracts"
import { EvalDetailPage } from "./eval-run-detail"
import {
  parseCompareIds,
  evalComparisonUrl,
} from "@/src/lib/tracer/eval-comparison"
import { tracerApi, type CollectionListOptions } from "./api"
import { formatDate, formatRelative } from "./format"
import { SelectionActionButton } from "@/components/ui/selection-toolbar"
import { ChevronDown, ChevronRight, GitCompareArrows } from "lucide-react"
import { CollectionFilterBar } from "./collection-filter"
import { useCollectionFilter } from "./use-collection-filter"
import { useCollectionPages } from "./use-collection-pages"
import { CollectionPanel } from "./collection-panel"
import { CollectionPage } from "./collection-page"
import { ErrorState, ValuePreview } from "./primitives"
import { useWorkspaceHref } from "./workspace-path"
import { EvalGroupLinks } from "./eval-group-links"
import { HeaderDisplay, type DisplaySettingGroup } from "./collection-header"
import { CollectionPagination } from "./collection-pagination"
import { CollectionTableSkeleton } from "@/components/ui/collection-skeleton"
import { Button } from "@/components/ui/button"
import { useTableView } from "./use-table-view"
import { CustomViewControls } from "./custom-view-controls"
import { useWorkspaceStorageScope } from "./workspace-path"

const EvalTableViewContext = React.createContext<ReturnType<typeof useTableView> | null>(null)

function groupingSettings(groupBy: string): DisplaySettingGroup[] {
  return [
    {
      label: "Grouping",
      items: [
        {
          id: "eval-group-by",
          label: "Group by",
          value: groupBy,
          options: [
            { value: "none", label: "None" },
            { value: "workflow", label: "Workflow" },
            { value: "agent", label: "Agent" },
          ],
          onChange: (value) => {
            const url = new URL(window.location.href)
            if (value === "none") url.searchParams.delete("groupBy")
            else url.searchParams.set("groupBy", value)
            window.history.replaceState(
              null,
              "",
              `${url.pathname}${url.search}${url.hash}`
            )
          },
        },
      ],
    },
  ]
}

function EvalRunsTable({
  runs,
  filtered,
  checkedIds,
  setCheckedIds,
  embedded = false,
}: {
  embedded?: boolean
  runs: EvalRunSummary[]
  filtered: boolean
  checkedIds: Set<string>
  setCheckedIds: React.Dispatch<React.SetStateAction<Set<string>>>
}) {
  const router = useRouter()
  const workspaceHref = useWorkspaceHref()
  const tableView = React.useContext(EvalTableViewContext)
  const rows = runs.map((run, index) => ({ id: run.id, run, index }))
  const scoreNames = [
    ...new Set(
      runs.flatMap((run) => run.scores?.map((score) => score.name) ?? [])
    ),
  ]
  const checkedCount = runs.filter((run) => checkedIds.has(run.id)).length
  const allChecked = runs.length > 0 && checkedCount === runs.length
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <CollectionTable
        settings={tableView?.settings}
        onSettingsChange={tableView?.onSettingsChange}
        columnOrderStore={tableView?.columnOrderStore}
        persistenceKey="eval-runs"
        fillHeight={!embedded}
        displayControls={!embedded}
        enableCardView={!embedded}
        enableRowHeight={!embedded}
        displaySettings={embedded ? undefined : groupingSettings("none")}
        columnIds={[
          "run",
          "groups",
          "all-scores",
          ...scoreNames.map((name) => `score:${name}`),
          "results",
          "metadata",
          "created",
        ]}
        widths={[280, 300, 120, ...scoreNames.map(() => 160), 120, 260, 200]}
      >
        <thead className={collectionTable.head}>
          <tr>
            <th scope="col" className="px-3 align-middle">
              <CollectionSelectAll
                checked={allChecked}
                partial={checkedCount > 0 && !allChecked}
                disabled={!runs.length}
                label="Select all visible eval runs"
                onChange={() =>
                  setCheckedIds((current) => {
                    const next = new Set(current)
                    for (const run of runs) {
                      if (allChecked) next.delete(run.id)
                      else next.add(run.id)
                    }
                    return next
                  })
                }
              />
            </th>
            <th scope="col" className={collectionTable.heading}>
              Run
              <span className="mt-0.5 block text-xs">{runs.length} runs</span>
            </th>
            {[
              "Operations",
              "All Scores",
              ...scoreNames,
              "Results",
              "Metadata",
              "Created",
            ].map((label) => (
              <th key={label} scope="col" className={collectionTable.heading}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <CollectionTableBody
          rows={rows}
          empty={
            !runs.length ? (
              <tr>
                <td
                  colSpan={7 + scoreNames.length}
                  className="py-10 text-center text-sm text-muted-foreground"
                >
                  {filtered
                    ? "No matching eval runs. Try changing or clearing the filter."
                    : "No eval runs yet."}
                </td>
              </tr>
            ) : null
          }
        >
          {(entry) => {
            const { run, index } = entry
            return (
              <CollectionRow
                key={run.id}
                checked={checkedIds.has(run.id)}
                tabIndex={0}
                aria-label={`Open ${run.name ?? "Untitled eval run"}`}
                onClick={() =>
                  router.push(
                    workspaceHref(`/evals/${encodeURIComponent(run.id)}`)
                  )
                }
                onKeyDown={(event) => {
                  if (
                    event.target !== event.currentTarget ||
                    (event.key !== "Enter" && event.key !== " ")
                  )
                    return
                  event.preventDefault()
                  router.push(
                    workspaceHref(`/evals/${encodeURIComponent(run.id)}`)
                  )
                }}
              >
                <CollectionRowSelection
                  index={index}
                  checked={checkedIds.has(run.id)}
                  label={`Select eval run ${index + 1}: ${run.name ?? "Untitled eval run"}`}
                  onChange={() =>
                    setCheckedIds((current) => {
                      const next = new Set(current)
                      if (next.has(run.id)) next.delete(run.id)
                      else next.add(run.id)
                      return next
                    })
                  }
                />
                <td className={collectionTable.cell}>
                  <Link
                    className="flex min-w-0 items-center gap-2 font-medium hover:underline focus-visible:outline-ring"
                    title={run.id}
                    href={workspaceHref(`/evals/${encodeURIComponent(run.id)}`)}
                  >
                    <SpanKindIcon kind="eval" />
                    <span className="truncate">
                      {run.name ?? "Untitled eval run"}
                    </span>
                  </Link>
                </td>
                <td className={collectionTable.cell}>
                  <EvalGroupLinks run={run} compact />
                </td>
                <td className={collectionTable.cell}>
                  <PercentageCell value={run.score} />
                </td>
                {scoreNames.map((name) => {
                  const value = run.scores?.find(
                    (score) => score.name === name
                  )?.value
                  return (
                    <td key={name} className={collectionTable.cell}>
                      {typeof value === "boolean" ? (
                        <ResultIcon success={value} />
                      ) : value == null || (value >= 0 && value <= 1) ? (
                        <PercentageCell value={value} />
                      ) : (
                        <span className="tabular-nums">
                          {value.toLocaleString()}
                        </span>
                      )}
                    </td>
                  )
                })}
                <td className={collectionTable.cell}>
                  <span className="tabular-nums">{run.resultCount}</span>
                </td>
                <td className={collectionTable.cell}>
                  <ValuePreview value={run.metadata ?? {}} />
                </td>
                <td className={collectionTable.cell} title={formatDate(run.createdAt)}>
                  <span className="tabular-nums">
                    {formatRelative(run.createdAt)}
                  </span>
                </td>
              </CollectionRow>
            )
          }}
        </CollectionTableBody>
      </CollectionTable>
    </div>
  )
}

export function EvalsPage() {
  const query = useSearchParams()
  const ids = parseCompareIds(query.get("compare"))
  return ids.length ? <EvalDetailPage runId={ids[0]} /> : <EvalCollectionPage />
}

function EvalCollectionPage() {
  const query = useSearchParams()
  const groupBy = query.get("groupBy")
  const storageScope = useWorkspaceStorageScope()
  const tableView = useTableView({
    resource: "evaluations",
    settingsStorageKey: `datool:table:${storageScope}:eval-runs`,
    orderStorageKey: `datool:table:${storageScope}:eval-runs:columns`,
  })
  return (
    <EvalTableViewContext.Provider value={tableView}>
      <CollectionPanel label="Evals">
        {tableView.savedView && <CustomViewControls {...tableView.savedView} />}
        {groupBy === "workflow" || groupBy === "agent" ? <EvalGroupedRunsPage key={groupBy} groupBy={groupBy} /> : <EvalRunsPage />}
      </CollectionPanel>
    </EvalTableViewContext.Provider>
  )
}

function EvalRunsPage() {
  const router = useRouter()
  const search = useCollectionFilter("evals")
  const runsState = useCollectionPages(tracerApi.evals.list, search.filter)
  const [selection, setSelection] = React.useState(() => ({
    filter: search.filter,
    ids: new Set<string>(),
  }))
  const checkedIds =
    selection.filter === search.filter ? selection.ids : new Set<string>()
  const setCheckedIds: React.Dispatch<React.SetStateAction<Set<string>>> = (
    change
  ) =>
    setSelection((current) => {
      const ids =
        current.filter === search.filter ? current.ids : new Set<string>()
      return {
        filter: search.filter,
        ids: typeof change === "function" ? change(ids) : change,
      }
    })
  const selected = runsState.items.filter((run) => checkedIds.has(run.id))
  return (
      <CollectionPage
        className="contents"
        state={runsState}
        loadingLabel="Loading eval runs"
        selection={{
          rows: selected,
          onClear: () => setCheckedIds(new Set()),
          actions: (
            <SelectionActionButton
              disabled={selected.length < 2}
              title="Select at least two runs to compare"
              onClick={() => {
                if (selected.length >= 2)
                  router.push(evalComparisonUrl(selected.map((run) => run.id)))
              }}
            >
              <GitCompareArrows className="size-3.5" />
              <PanelActionLabel>Compare ({selected.length})</PanelActionLabel>
            </SelectionActionButton>
          ),
        }}
        header={{
          exportRows: runsState.items,
          exportName: "eval-runs",
          actions: <ConnectedEvalButton />,
          children: (
            <CollectionFilterBar
              resource="evals"
              {...search}
              isLoading={runsState.isRefreshing || runsState.isLoading}
            />
          ),
        }}
        pagination={runsState}
      >
        <EvalRunsTable
          runs={runsState.items}
          filtered={!!search.filter}
          checkedIds={checkedIds}
          setCheckedIds={setCheckedIds}
        />
      </CollectionPage>
  )
}

function EvalGroupedRunsPage({ groupBy }: { groupBy: "workflow" | "agent" }) {
  const router = useRouter()
  const search = useCollectionFilter("evals")
  const list = React.useCallback(
    (options: CollectionListOptions) =>
      tracerApi.evals.groups(groupBy, options),
    [groupBy]
  )
  const groups = useCollectionPages(list, search.filter, 30_000)
  const [selection, setSelection] = React.useState({
    filter: search.filter,
    runs: new Map<string, EvalRunSummary>(),
  })
  const selected =
    selection.filter === search.filter
      ? selection.runs
      : new Map<string, EvalRunSummary>()
  const setCheckedIds = (
    runs: EvalRunSummary[],
    change: React.SetStateAction<Set<string>>
  ) =>
    setSelection((current) => {
      const saved =
        current.filter === search.filter
          ? current.runs
          : new Map<string, EvalRunSummary>()
      const ids =
        typeof change === "function" ? change(new Set(saved.keys())) : change
      const available = new Map([
        ...saved,
        ...runs.map((run) => [run.id, run] as const),
      ])
      return {
        filter: search.filter,
        runs: new Map([...available].filter(([id]) => ids.has(id))),
      }
    })
  return (
      <CollectionPage
        className="contents"
        state={groups}
        loadingLabel="Loading eval groups"
        pagination={groups}
        header={{
          exportRows: groups.items,
          exportName: "eval-groups",
          actions: <ConnectedEvalButton />,
          children: (
            <CollectionFilterBar
              resource="evals"
              {...search}
              isLoading={groups.isRefreshing || groups.isLoading}
            />
          ),
        }}
        selection={{
          rows: [...selected.values()],
          onClear: () => setCheckedIds([], new Set()),
          actions: (
            <SelectionActionButton
              disabled={selected.size < 2}
              title="Select at least two runs to compare"
              onClick={() => {
                if (selected.size >= 2)
                  router.push(evalComparisonUrl([...selected.keys()]))
              }}
            >
              <GitCompareArrows className="size-3.5" />
              <PanelActionLabel>Compare ({selected.size})</PanelActionLabel>
            </SelectionActionButton>
          ),
        }}
      >
        <HeaderDisplay
          settings={groupingSettings(groupBy)}
          columns={[]}
          onChange={() => {}}
        />
        <div className="min-h-0 flex-1 overflow-auto">
          {!groups.items.length && (
            <p className="p-8 text-center text-sm text-foreground-muted">
              {search.filter
                ? "No matching eval runs. Try changing or clearing the filter."
                : "No eval runs yet."}
            </p>
          )}
          {groups.items.map((group, index) => (
            <EvalGroupSection
              key={`${search.filter}:${group.id}`}
              group={group}
              defaultOpen={index === 0}
              checkedIds={new Set(selected.keys())}
              onSelection={setCheckedIds}
            />
          ))}
        </div>
      </CollectionPage>
  )
}

function EvalGroupSection({
  group,
  defaultOpen,
  checkedIds,
  onSelection,
}: {
  group: EvalRunGroupSummary
  defaultOpen: boolean
  checkedIds: Set<string>
  onSelection: (
    runs: EvalRunSummary[],
    change: React.SetStateAction<Set<string>>
  ) => void
}) {
  const [open, setOpen] = React.useState(defaultOpen)
  const contentId = React.useId()
  const name =
    group.state === "assigned"
      ? group.name
      : group.state === "unresolved"
        ? "Not resolved"
        : "Unassigned"
  return (
    <section className="border-b border-border">
      <Button
        variant="ghost"
        className="w-full justify-start rounded-none"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen(!open)}
      >
        {open ? (
          <ChevronDown className="size-4" />
        ) : (
          <ChevronRight className="size-4" />
        )}
        <span className="truncate">{name}</span>
        <span className="ml-auto text-xs text-foreground-muted">
          {group.runCount} {group.runCount === 1 ? "run" : "runs"}
        </span>
      </Button>
      {open && (
        <div id={contentId}>
          <EvalGroupContents
            group={group}
            checkedIds={checkedIds}
            onSelection={onSelection}
          />
        </div>
      )}
    </section>
  )
}

function EvalGroupContents({
  group,
  checkedIds,
  onSelection,
}: {
  group: EvalRunGroupSummary
  checkedIds: Set<string>
  onSelection: (
    runs: EvalRunSummary[],
    change: React.SetStateAction<Set<string>>
  ) => void
}) {
  const runs = useCollectionPages(tracerApi.evals.list, group.filter, 30_000)
  return (
    <>
      {runs.error && <ErrorState error={runs.error} onRetry={runs.refresh} />}
      {runs.isLoading && !runs.data ? (
        <CollectionTableSkeleton label="Loading group runs" />
      ) : (
        <EvalRunsTable
          embedded
          runs={runs.items}
          filtered
          checkedIds={checkedIds}
          setCheckedIds={(change) => onSelection(runs.items, change)}
        />
      )}
      <CollectionPagination {...runs} />
    </>
  )
}

export { EvalDetailPage } from "./eval-run-detail"
