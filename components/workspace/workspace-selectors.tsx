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
  /** Render only one switcher when the shell places them in different regions. */
  only?: "organization" | "project"
}

export function WorkspaceSelectors(props: WorkspaceSelectorsProps) {
  const [queryClient] = React.useState(createWorkspaceSelectorClient)
  return (
    <QueryClientProvider client={queryClient}>
      <WorkspaceSelectorControls {...props} />
    </QueryClientProvider>
  )
}

function OrganizationProjectsSubmenu({
  organization,
  currentOrganizationId,
  selectedProjectId,
  organizationDestination,
  onClose,
}: {
  organization: WorkspaceOrganization
  currentOrganizationId: string
  selectedProjectId?: string
  organizationDestination: string
  onClose: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const [search, setSearch] = React.useState("")
  const [selectionError, setSelectionError] = React.useState<{
    error: Error
    href: string
  } | null>(null)
  const selecting = React.useRef(false)
  const projects = useQuery({
    queryKey: workspaceSelectorKeys.projectSearch(organization.id, search),
    queryFn: ({ signal }) =>
      listWorkspaceProjects(organization.id, {
        signal,
        search,
        pageSize: 100,
      }),
    enabled: open,
  })

  async function navigate(href: string) {
    if (selecting.current) return
    selecting.current = true
    setSelectionError(null)
    try {
      if (organization.id !== currentOrganizationId) {
        await selectOrganization(organization.id)
      }
      navigateWorkspace(href)
      onClose()
    } catch (cause) {
      setSelectionError({
        href,
        error:
          cause instanceof Error
            ? cause
            : new Error("Unable to select organization."),
      })
    } finally {
      selecting.current = false
    }
  }

  return (
    <ResourceSwitcher
      label="project"
      value={organization.name}
      submenu={{ selected: organization.id === currentOrganizationId }}
      selectedId={
        organization.id === currentOrganizationId
          ? selectedProjectId
          : undefined
      }
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (!value) {
          setSearch("")
          setSelectionError(null)
        }
      }}
      search={search}
      onSearchChange={setSearch}
      items={(projects.data?.projects ?? []).map((item) => ({
        ...item,
        href: projectHref(organization, item),
      }))}
      loading={projects.isLoading}
      error={selectionError?.error ?? projects.error}
      onRetry={() => {
        if (selectionError) void navigate(selectionError.href)
        else void projects.refetch()
      }}
      onItemSelect={(item) => void navigate(item.href)}
      moreHref={organizationDestination}
      moreLabel={
        organizationDestination === "/projects"
          ? "View all projects"
          : "View organization"
      }
      onMoreSelect={() => void navigate(organizationDestination)}
    />
  )
}

function WorkspaceSelectorControls({
  organization,
  project,
  organizationDestination = "/projects",
  only,
}: WorkspaceSelectorsProps) {
  const queryClient = useQueryClient()
  const [organizationOpen, setOrganizationOpen] = React.useState(false)
  const organizationTrigger = React.useRef<HTMLButtonElement>(null)
  const projectTrigger = React.useRef<HTMLButtonElement>(null)
  const [projectOpen, setProjectOpen] = React.useState(false)
  const [organizationSearch, setOrganizationSearch] = React.useState("")
  const [projectSearch, setProjectSearch] = React.useState("")
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
      {only !== "project" ? (
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
                item.name
                  .toLowerCase()
                  .includes(organizationSearch.toLowerCase())
              )
              .map((item) => ({
                ...item,
                href: organizationDestination,
              }))}
            loading={organizations.isLoading}
            error={organizations.error}
            onRetry={() => void organizations.refetch()}
            renderItem={(item, close) => {
              const itemOrganization = organizations.data?.find(
                (candidate) => candidate.id === item.id
              )
              return itemOrganization ? (
                <OrganizationProjectsSubmenu
                  organization={itemOrganization}
                  currentOrganizationId={organization.id}
                  selectedProjectId={project?.id}
                  organizationDestination={item.href}
                  onClose={close}
                />
              ) : null
            }}
            onCreate={() => navigateWorkspace("/organizations/new")}
          />
        </div>
      ) : null}
      {project && only === "project" ? (
        <ResourceSwitcher
          label="project"
          triggerRef={projectTrigger}
          triggerClassName="h-8 w-auto max-w-56"
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
          moreHref={projectHref(organization, project, "projects")}
        />
      ) : null}
      {project && !only ? (
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
