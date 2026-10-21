"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { NextNavigationProvider } from "@/components/navigation/next-navigation"
import {
  BookOpenCheck,
  LoaderCircle,
  Play,
  ArrowLeft,
  Settings,
} from "lucide-react"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { workspacePrefix } from "@/lib/workspace-routing"
import { pageTitles } from "@/lib/page-metadata"
import {
  projectWorkspaceHref,
  type WorkspaceOrganization,
  type WorkspaceProject,
} from "@/lib/workspace-api"
import { WorkspaceSelectors } from "@/components/workspace/workspace-selectors"
import {
  AccountMenu,
  type AccountMenuUser,
} from "@/components/workspace/account-menu"
import { tracerApi } from "./api"
import { useMutation } from "./hooks"
import { WorkspacePageLayout } from "./workspace-page-layout"

import { useReactViewWebMcp } from "./use-react-view-webmcp"
import { useViewLibraryWebMcp } from "./use-view-library-webmcp"
import { productIcons, selectedProductIcons } from "@/components/product-icons"
import { InspectorPanels } from "./inspector-panels"
import { useOrganizationSessionSync } from "@/lib/workspace-selection"
import {
  AgentSidebarProvider,
  AgentSidebarTarget,
} from "@/components/build/shared/agent-sidebar"
import {
  InboxSidebar,
  InboxSidebarProvider,
} from "@/components/build/shared/inbox-sidebar"

const routeGroups = [
  {
    label: "Build",
    routes: [
      {
        href: "/build/agents",
        icon: productIcons.buildAgents,
        label: pageTitles.buildAgents,
      },
      {
        href: "/build/conversations",
        icon: productIcons.buildConversations,
        activeIcon: selectedProductIcons.buildConversations,
        label: pageTitles.buildConversations,
      },
      {
        href: "/build/inbox",
        icon: productIcons.buildInbox,
        activeIcon: selectedProductIcons.buildInbox,
        label: pageTitles.buildInbox,
      },
      {
        href: "/build/contacts",
        icon: productIcons.buildContacts,
        label: pageTitles.buildContacts,
      },
    ],
  },
  {
    label: "Observe",
    routes: [
      { href: "/traces", icon: productIcons.traces, label: pageTitles.traces },
      {
        href: "/dashboards",
        icon: productIcons.dashboards,
        label: pageTitles.dashboards,
      },
      {
        href: "/agents",
        icon: productIcons.agents,
        label: "Agent performance",
      },
      {
        href: "/workflows",
        icon: productIcons.workflows,
        label: pageTitles.workflows,
      },
      {
        href: "/sessions",
        icon: productIcons.sessions,
        label: pageTitles.sessions,
      },
      {
        href: "/reports",
        icon: productIcons.reports,
        label: pageTitles.reports,
      },
      { href: "/alerts", icon: productIcons.alerts, label: pageTitles.alerts },
    ],
  },
  {
    label: "Test",
    routes: [
      {
        href: "/playground",
        icon: productIcons.playground,
        label: pageTitles.playground,
      },
      {
        href: "/build/tests",
        icon: productIcons.buildTests,
        label: pageTitles.buildTests,
      },
      { href: "/evals", icon: productIcons.evals, label: pageTitles.evals },
      {
        href: "/datasets",
        icon: productIcons.datasets,
        label: pageTitles.datasets,
      },
      {
        href: "/scorers",
        icon: productIcons.scorers,
        label: pageTitles.scorers,
      },
      {
        href: "/reviews",
        icon: productIcons.reviews,
        label: pageTitles.reviews,
      },
      {
        href: "/human-scores",
        icon: productIcons.humanScores,
        label: pageTitles.humanScores,
      },
      {
        href: "/prompts",
        icon: productIcons.prompts,
        label: pageTitles.prompts,
      },
    ],
  },
] as const

const settingsRoutes = [
  { href: "/settings", icon: productIcons.settings, label: "General" },
  {
    href: "/settings/members",
    icon: productIcons.members,
    label: pageTitles.members,
  },
  {
    href: "/settings/ai-providers",
    icon: productIcons.aiProviders,
    label: pageTitles.aiProviders,
  },
  {
    href: "/settings/sandbox-providers",
    icon: productIcons.sandboxProviders,
    label: pageTitles.sandboxProviders,
  },
  {
    href: "/settings/api-keys",
    icon: productIcons.apiKeys,
    label: pageTitles.apiKeys,
  },
  {
    href: "/settings/mcp",
    icon: productIcons.mcpConnections,
    label: pageTitles.mcpConnections,
  },
] as const

function DemoWorkflowButton({ compact = false }: { compact?: boolean }) {
  const router = useRouter()
  const pathname = usePathname()
  const { error, isPending, run } = useMutation()
  const [notice, setNotice] = React.useState<string | null>(null)

  const loadDemo = async () => {
    try {
      const created = await run(tracerApi.demo)
      setNotice("Sample workflow loaded")
      const prefix = workspacePrefix(pathname)
      router.push(
        `${prefix ?? "/"}/traces?trace=${encodeURIComponent(created.traceIds[0])}`
      )
    } catch {
      // The surfaced mutation state gives this action an actionable error.
    }
  }

  return (
    <div
      className={cn(
        "relative",
        compact && "group-data-[collapsible=icon]/sidebar:hidden"
      )}
    >
      <Button
        className={cn(
          "w-full justify-start",
          compact && "h-auto py-2 text-left whitespace-normal"
        )}
        onClick={() => void loadDemo()}
        size="sm"
        variant={compact ? "ghost" : "outline"}
      >
        {isPending ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : (
          <Play className="size-3.5" />
        )}
        <span>{isPending ? "Loading sample…" : "Load sample workflow"}</span>
        <span
          className={cn(
            "ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase",
            !compact && "border border-border"
          )}
        >
          Demo
        </span>
      </Button>
      {notice ? (
        <p className="mt-2 px-1 text-xs text-success">{notice}</p>
      ) : null}
      {error ? (
        <p className="mt-2 px-1 text-xs leading-5 text-destructive">
          {error.message}
        </p>
      ) : null}
    </div>
  )
}

type WorkspaceShellProps = {
  user: AccountMenuUser
  organization: WorkspaceOrganization
  project: Pick<WorkspaceProject, "id" | "name" | "slug">
}

function AppSidebar({ organization, project, user }: WorkspaceShellProps) {
  const pathname = usePathname()
  const { isMobile, setOpenMobile } = useSidebar()
  const closeMobileNavigation = () => {
    if (isMobile) setOpenMobile(false)
  }
  const prefix = projectWorkspaceHref(organization, project)
  const inInbox = pathname === `${prefix}/build/inbox`
  const inSettings =
    pathname === `${prefix}/settings` ||
    pathname.startsWith(`${prefix}/settings/`)

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="p-2">
        <WorkspaceSelectors organization={organization} project={project} />
      </SidebarHeader>

      <SidebarContent>
        <AgentSidebarTarget>
          {!inSettings && !inInbox && (
            <SidebarGroup>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    className="h-7 text-xs"
                    isActive={pathname === prefix || pathname === `${prefix}/`}
                    aria-current={
                      pathname === prefix || pathname === `${prefix}/`
                        ? "page"
                        : undefined
                    }
                    onClick={closeMobileNavigation}
                    render={<Link href={prefix || "/"} prefetch={true} />}
                  >
                    <productIcons.home />
                    <span>Home</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
          )}
          {inInbox ? (
            <InboxSidebar />
          ) : (
            (inSettings
              ? [{ label: "Project settings", routes: settingsRoutes }]
              : routeGroups
            ).map((group) => (
              <SidebarGroup key={group.label}>
                <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                <SidebarMenu>
                  {group.routes.map((route) => {
                    const href = `${prefix}${route.href}`
                    const active =
                      pathname === href ||
                      (route.href !== "/settings" &&
                        pathname.startsWith(`${href}/`)) ||
                      (route.href === "/playground" &&
                        pathname.startsWith(`${prefix}/apps/`))
                    const Icon =
                      active && "activeIcon" in route && route.activeIcon
                        ? route.activeIcon
                        : route.icon
                    const link = (
                      <SidebarMenuButton
                        className="h-7 text-xs group-data-[collapsible=icon]/sidebar:size-7"
                        isActive={active}
                        onClick={closeMobileNavigation}
                        aria-current={active ? "page" : undefined}
                        render={<Link href={href} prefetch={true} />}
                      >
                        <Icon />
                        <span>{route.label}</span>
                      </SidebarMenuButton>
                    )
                    return (
                      <SidebarMenuItem key={route.href}>{link}</SidebarMenuItem>
                    )
                  })}
                </SidebarMenu>
              </SidebarGroup>
            ))
          )}
        </AgentSidebarTarget>
      </SidebarContent>

      <SidebarFooter className="p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={closeMobileNavigation}
              render={<Link href="/docs" />}
            >
              <BookOpenCheck />
              <span>Documentation</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={closeMobileNavigation}
              render={
                <Link
                  href={`${prefix}${inSettings ? "/traces" : "/settings"}`}
                  prefetch={true}
                />
              }
            >
              {inSettings ? <ArrowLeft /> : <Settings />}
              <span>
                {inSettings ? "Back to project" : pageTitles.projectSettings}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <AccountMenu user={user} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

export function TracerAppShell(
  props: React.PropsWithChildren<WorkspaceShellProps>
) {
  return (
    <NextNavigationProvider>
      <TracerAppShellContent {...props} />
    </NextNavigationProvider>
  )
}

function TracerAppShellContent({
  children,
  organization,
  project,
  user,
}: React.PropsWithChildren<WorkspaceShellProps>) {
  useReactViewWebMcp(project.id)
  useViewLibraryWebMcp(project.id)
  useOrganizationSessionSync(organization.id)
  return (
    <SidebarProvider>
      <AgentSidebarProvider key={project.id}>
        <InboxSidebarProvider>
          <AppSidebar
            organization={organization}
            project={project}
            user={user}
          />
          <SidebarInset>
            <WorkspacePageLayout
              leading={<SidebarTrigger className="-ml-0.5 shrink-0" />}
            >
              <InspectorPanels>{children}</InspectorPanels>
            </WorkspacePageLayout>
          </SidebarInset>
        </InboxSidebarProvider>
      </AgentSidebarProvider>
    </SidebarProvider>
  )
}

export function DemoWorkflowAction() {
  return <DemoWorkflowButton />
}

export function ApiHelpLink() {
  return (
    <Link
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      href="/docs/tracing/instrumentation"
    >
      <BookOpenCheck className="size-4" />
      Trace ingestion API
    </Link>
  )
}
