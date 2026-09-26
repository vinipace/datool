"use client"

import type { ReactNode } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { ArrowLeft, CreditCard, Settings, Users, ChartPie } from "lucide-react"
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
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import { PageLayout } from "@/components/tracer/page-layout"
import type { WorkspaceOrganization } from "@/lib/workspace-api"
import { WorkspaceSelectors } from "./workspace-selectors"

const organizationSettingsRoutes = [
  { title: "General", href: "/settings/general", icon: Settings },
  { title: "Members", href: "/members", icon: Users },
  { title: "Usage", href: "/usage", icon: ChartPie },
  { title: "Billing", href: "/billing", icon: CreditCard },
]

function OrganizationSettingsSidebar({
  title,
  organization,
  backHref,
}: {
  title: string
  organization: WorkspaceOrganization
  backHref: string
}) {
  const { isMobile, setOpenMobile } = useSidebar()
  const pathname = usePathname()
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false)
  }
  return (
    <Sidebar collapsible="offcanvas" aria-label="Organization settings">
      <SidebarHeader className="p-2">
        <WorkspaceSelectors
          key={`${organization.id}:${organization.name}:${organization.slug}`}
          organization={organization}
          organizationDestination={pathname}
        />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Organization settings</SidebarGroupLabel>
          <SidebarMenu>
            {organizationSettingsRoutes.map((item) => (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton
                  className="h-7 text-xs"
                  isActive={title === item.title}
                  aria-current={title === item.title ? "page" : undefined}
                  onClick={closeMobile}
                  render={<Link href={item.href} />}
                >
                  <item.icon />
                  <span>{item.title}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={closeMobile}
              render={<Link href={backHref} />}
            >
              <ArrowLeft />
              <span>Back to workspace</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

export function SettingsShell({
  title,
  backHref,
  children,
  embedded = false,
  organization,
}: {
  title: string
  backHref: string
  children: ReactNode
  embedded?: boolean
  organization?: WorkspaceOrganization
}) {
  const pathname = usePathname()
  // Layouts persist across navigation, so derive the current title on the client.
  const pageTitle = organization
    ? (organizationSettingsRoutes.find((item) => item.href === pathname)
        ?.title ?? title)
    : title

  if (embedded)
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {children}
      </div>
    )
  if (organization)
    return (
      <SidebarProvider defaultOpen>
        <OrganizationSettingsSidebar
          title={pageTitle}
          organization={organization}
          backHref={backHref}
        />
        <SidebarInset className="h-svh overflow-hidden">
          <PageLayout
            title={pageTitle}
            leading={<SidebarTrigger className="-ml-0.5 shrink-0" />}
          >
            <div className="flex min-h-0 flex-1 flex-col overflow-auto">
              {children}
            </div>
          </PageLayout>
        </SidebarInset>
      </SidebarProvider>
    )
  return (
    <main className="min-h-svh overflow-x-hidden bg-background text-foreground">
      <header className="flex min-h-11 flex-wrap items-center gap-3 border-b border-border px-3 py-2 text-sm">
        <Link
          className="text-foreground-muted hover:text-foreground"
          href={backHref}
        >
          Settings
        </Link>
        <span className="text-empty-foreground" aria-hidden="true">
          /
        </span>
        <span className="font-medium">{title}</span>
        <Link
          className="ml-auto text-foreground-muted hover:text-foreground"
          href={backHref}
        >
          Back to workspace
        </Link>
      </header>
      {children}
    </main>
  )
}
