"use client"

import { usePathname } from "next/navigation"
import { workspacePrefix } from "@/lib/workspace-routing"
import { PageLoading } from "@/components/ui/loading-state"
import { DashboardSkeleton } from "@/components/ui/dashboard-skeleton"
import { PromptEditorSkeleton } from "@/components/ui/prompt-editor-skeleton"
import { WorkspacePageLayout } from "./workspace-page-layout"

/** Child routes already have a header from the mounted project shell. */
export function ProjectPageLoading() {
  const pathname = usePathname()
  const prefix = workspacePrefix(pathname)
  if (prefix && pathname.startsWith(`${prefix}/prompts/`))
    return <PromptEditorSkeleton />
  if (prefix && pathname.startsWith(`${prefix}/dashboards/`))
    return <DashboardSkeleton />
  return <PageLoading histogram={!!prefix && pathname === `${prefix}/traces`} />
}

/** The outer boundary also covers the async project layout, including its header. */
export function WorkspaceLoading() {
  return (
    <WorkspacePageLayout>
      <ProjectPageLoading />
    </WorkspacePageLayout>
  )
}
