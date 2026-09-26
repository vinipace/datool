"use client"

import * as React from "react"
import Link from "next/link"
import Image from "next/image"
import {
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { ResourceSwitcher } from "@/components/ui/resource-switcher"
import { Button } from "@/components/ui/button"
import { authClient } from "@/lib/auth-client"
import {
  createWorkspaceSelectorClient,
  workspaceSelectorKeys,
} from "@/lib/workspace-selector-cache"
import {
  listWorkspaceProjects,
  projectHref,
  type WorkspaceOrganization,
  type WorkspaceProject,
} from "@/lib/workspace-api"
import {
  navigateWorkspace,
  selectOrganization,
} from "@/lib/workspace-selection"
import { CreateWorkspaceDialog } from "./create-workspace-dialog"

type WorkspaceSelectorsProps = {
  organization: WorkspaceOrganization
  project?: Pick<WorkspaceProject, "id" | "name" | "slug">
  organizationDestination?: string
}

export function WorkspaceSelectors(props: WorkspaceSelectorsProps) {
  const [queryClient] = React.useState(createWorkspaceSelectorClient)
  return (
    <QueryClientProvider client={queryClient}>
      <WorkspaceSelectorControls {...props} />
    </QueryClientProvider>
  )
}

function WorkspaceSelectorControls({
  organization,
  project,
  organizationDestination = "/projects",
}: WorkspaceSelectorsProps) {
  const queryClient = useQueryClient()
  const [organizationOpen, setOrganizationOpen] = React.useState(false)
  const organizationTrigger = React.useRef<HTMLButtonElement>(null)
  const projectTrigger = React.useRef<HTMLButtonElement>(null)
  const [projectOpen, setProjectOpen] = React.useState(false)
  const [organizationSearch, setOrganizationSearch] = React.useState("")
  const [projectSearch, setProjectSearch] = React.useState("")
  const [organizationSelectionError, setOrganizationSelectionError] =
    React.useState<string | null>(null)
  const [creatingProject, setCreatingProject] = React.useState(false)
  const organizations = useQuery({
    queryKey: workspaceSelectorKeys.organizations,
    queryFn: async ({ signal }) => {
      const result = await authClient.organization.list({
        fetchOptions: { signal },
      })
      if (result.error)
        throw new Error(result.error.message ?? "Unable to load organizations.")
      return result.data ?? []
    },
    enabled: organizationOpen,
  })
  const projects = useQuery({
    queryKey: workspaceSelectorKeys.projectSearch(
      organization.id,
      projectSearch
    ),
    queryFn: ({ signal }) =>
      listWorkspaceProjects(organization.id, {
        signal,
        search: projectSearch,
        pageSize: 100,
      }),
    enabled: !!project && projectOpen,
  })

  return (
    <>
      <div className="min-w-0">
        <ResourceSwitcher
          label="organization"
          leadingIcon={
            <Image
              src="/icon.svg"
              alt=""
              width={20}
              height={20}
              unoptimized
              className="size-5 shrink-0"
            />
          }
          triggerRef={organizationTrigger}
          value={organization.name}
          selectedId={organization.id}
          open={organizationOpen}
          onOpenChange={(value) => {
            setOrganizationOpen(value)
            if (!value) setOrganizationSearch("")
          }}
          search={organizationSearch}
          onSearchChange={setOrganizationSearch}
          items={(organizations.data ?? [])
            .filter((item) =>
              item.name.toLowerCase().includes(organizationSearch.toLowerCase())
            )
            .map((item) => ({
              ...item,
              href:
                item.id === organization.id && project
                  ? projectHref(organization, project)
                  : organizationDestination,
            }))}
          loading={organizations.isLoading}
          error={organizations.error}
          onRetry={() => void organizations.refetch()}
          onItemSelect={(item) => {
            if (item.id === organization.id) return
            void selectOrganization(item.id)
              .then(() => navigateWorkspace(organizationDestination))
              .catch((cause) => {
                setOrganizationSelectionError(
                  cause instanceof Error
                    ? cause.message
                    : "Unable to select organization."
                )
              })
          }}
          onCreate={() => navigateWorkspace("/organizations/new")}
        />
        {organizationSelectionError ? (
          <p role="alert" className="px-2 pt-1 text-xs text-destructive">
            {organizationSelectionError}
          </p>
        ) : null}
      </div>
      {project ? (
        <div className="min-w-0">
          <div className="flex items-center justify-between px-2">
            <span className="text-xs text-foreground-muted">Project</span>
            <Button
              asChild
              variant="ghost-muted"
              size="sm"
              className="h-6 px-0 text-xs"
            >
              <Link href={projectHref(organization, project, "projects")}>
                View all
              </Link>
            </Button>
          </div>
          <ResourceSwitcher
            label="project"
            triggerRef={projectTrigger}
            value={project.name}
            selectedId={project.id}
            open={projectOpen}
            onOpenChange={(value) => {
              setProjectOpen(value)
              if (!value) setProjectSearch("")
            }}
            search={projectSearch}
            onSearchChange={setProjectSearch}
            items={(projects.data?.projects ?? []).map((item) => ({
              ...item,
              href: projectHref(organization, item),
            }))}
            loading={projects.isLoading}
            error={projects.error}
            onRetry={() => void projects.refetch()}
            onCreate={() => setCreatingProject(true)}
            moreHref={
              projects.data &&
              projects.data.total > projects.data.projects.length
                ? projectHref(organization, project, "projects")
                : undefined
            }
          />
        </div>
      ) : null}
      {creatingProject ? (
        <CreateWorkspaceDialog
          kind="project"
          organization={organization}
          open
          onCreated={() => {
            void queryClient.invalidateQueries({
              queryKey: workspaceSelectorKeys.projects(organization.id),
            })
          }}
          returnFocusRef={projectTrigger}
          onOpenChange={setCreatingProject}
        />
      ) : null}
    </>
  )
}
