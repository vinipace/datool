"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Database, FlaskConical, Network, Plus, Search } from "lucide-react"
import { CollectionPage } from "@/components/tracer/collection-page"
import { useRemote } from "@/components/tracer/hooks"
import {
  LogRow,
  LogRowSelection,
  LogSelectAll,
  LogTable,
  LogTableBody,
} from "@/components/tracer/log-table"
import { logTable } from "@/components/tracer/log-table-styles"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  listWorkspaceProjects,
  projectHref,
  type WorkspaceOrganization,
} from "@/lib/workspace-api"
import { CreateWorkspaceDialog } from "./create-workspace-dialog"

export function ProjectsPage({
  organization,
}: {
  organization: WorkspaceOrganization
}) {
  const router = useRouter()
  const [search, setSearch] = React.useState("")
  const [page, setPage] = React.useState(1)
  const [creating, setCreating] = React.useState(false)
  const [checkedIds, setCheckedIds] = React.useState<Set<string>>(
    () => new Set()
  )
  const load = React.useCallback(
    (signal: AbortSignal) =>
      listWorkspaceProjects(organization.id, {
        signal,
        search,
        page,
        includeStats: true,
      }),
    [organization.id, search, page]
  )
  const state = useRemote(load, [organization.id])
  const projects = state.data?.projects ?? []
  const selected = projects.filter((project) => checkedIds.has(project.id))
  const allChecked = projects.length > 0 && selected.length === projects.length
  const total = state.data?.total ?? 0

  function toggle(id: string) {
    setCheckedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <>
      <CollectionPage
        state={state}
        loadingLabel="Loading projects"
        header={{
          exportRows: selected.length ? selected : projects,
          exportName: "projects",
        }}
        toolbar={
          <div className="mb-2 flex min-w-0 items-center gap-2">
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-4" />
              Project
            </Button>
            <div className="relative min-w-0 flex-1">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-2 left-3 size-4 text-foreground-muted"
              />
              <Input
                aria-label="Find projects"
                placeholder="Find projects"
                className="h-8 pl-9"
                maxLength={120}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value)
                  setPage(1)
                }}
              />
            </div>
          </div>
        }
      >
        <LogTable
          persistenceKey="projects"
          fillHeight
          columnIds={["name", "evals", "datasets", "traces", "created"]}
          widths={[360, 140, 140, 140, 180]}
        >
          <thead className={logTable.head}>
            <tr>
              <th scope="col" className="px-3 align-middle">
                <LogSelectAll
                  checked={allChecked}
                  partial={selected.length > 0 && !allChecked}
                  disabled={!projects.length}
                  label="Select all visible projects"
                  onChange={() =>
                    setCheckedIds((current) => {
                      const next = new Set(current)
                      for (const project of projects) {
                        if (allChecked) next.delete(project.id)
                        else next.add(project.id)
                      }
                      return next
                    })
                  }
                />
              </th>
              <th scope="col" className={logTable.heading}>
                Name
              </th>
              <th scope="col" aria-label="Evals" className={logTable.heading}>
                <span className="inline-flex items-center gap-1.5">
                  <FlaskConical className="size-3.5" />
                  Evals
                </span>
              </th>
              <th scope="col" aria-label="Datasets" className={logTable.heading}>
                <span className="inline-flex items-center gap-1.5">
                  <Database className="size-3.5" />
                  Datasets
                </span>
              </th>
              <th scope="col" aria-label="Traces" className={logTable.heading}>
                <span className="inline-flex items-center gap-1.5">
                  <Network className="size-3.5" />
                  Traces
                </span>
              </th>
              <th scope="col" className={logTable.heading}>
                Created
              </th>
            </tr>
          </thead>
          <LogTableBody
            rows={projects}
            empty={
              <tr>
                <td
                  colSpan={6}
                  className="py-16 text-center text-sm text-foreground-muted"
                >
                  <p>{search ? "No matching projects" : "No projects yet"}</p>
                  <p className="mt-1 text-xs">
                    {search
                      ? "Try a different name or clear your search."
                      : "Create a project to start collecting traces, evals, and datasets."}
                  </p>
                </td>
              </tr>
            }
          >
            {(project, index) => (
              <LogRow
                key={project.id}
                checked={checkedIds.has(project.id)}
                tabIndex={0}
                aria-label={`Open ${project.name}`}
                onClick={() => router.push(projectHref(organization, project))}
                onKeyDown={(event) => {
                  if (
                    event.target !== event.currentTarget ||
                    (event.key !== "Enter" && event.key !== " ")
                  )
                    return
                  event.preventDefault()
                  router.push(projectHref(organization, project))
                }}
              >
                <LogRowSelection
                  index={index}
                  checked={checkedIds.has(project.id)}
                  label={`Select ${project.name}`}
                  onChange={() => toggle(project.id)}
                />
                <td className={logTable.cell}>
                  <Link
                    href={projectHref(organization, project)}
                    onClick={(event) => event.stopPropagation()}
                    className="block truncate rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {project.name}
                  </Link>
                </td>
                <td className={`${logTable.cell} tabular-nums`}>
                  {project.evalCount ?? "—"}
                </td>
                <td className={`${logTable.cell} tabular-nums`}>
                  {project.datasetCount ?? "—"}
                </td>
                <td className={`${logTable.cell} tabular-nums`}>
                  {project.traceCount ?? "—"}
                </td>
                <td className={logTable.cell}>
                  {new Intl.DateTimeFormat(undefined, {
                    dateStyle: "medium",
                  }).format(new Date(project.createdAt))}
                </td>
              </LogRow>
            )}
          </LogTableBody>
        </LogTable>
        {total > (state.data?.pageSize ?? 25) ? (
          <nav
            aria-label="Project pages"
            className="flex shrink-0 items-center justify-end gap-3 pt-2 text-xs text-foreground-muted"
          >
            <Button
              variant="ghost"
              size="sm"
              disabled={page <= 1 || state.isLoading}
              onClick={() => setPage((current) => current - 1)}
            >
              Previous
            </Button>
            <span>
              Page {page} of {Math.ceil(total / (state.data?.pageSize ?? 25))}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={
                page * (state.data?.pageSize ?? 25) >= total || state.isLoading
              }
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </Button>
          </nav>
        ) : null}
      </CollectionPage>
      <CreateWorkspaceDialog
        kind="project"
        organization={organization}
        open={creating}
        onOpenChange={setCreating}
      />
    </>
  )
}
