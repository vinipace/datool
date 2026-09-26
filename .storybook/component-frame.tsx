import { type PropsWithChildren } from "react"
import { PageLayout } from "@/components/tracer/page-layout"
import { ProjectScopeProvider } from "@/components/tracer/project-scope"
import { cn } from "@/lib/utils"

export const storybookProject = {
  projectId: "storybook-project",
  organizationId: "storybook-organization",
  prefix: "/p/demo",
}

/** Project context and real header portal targets, without shell API requests. */
export function StorybookProjectFrame({
  children,
  projectId = storybookProject.projectId,
  organizationId = storybookProject.organizationId,
  prefix = storybookProject.prefix,
  title = "Storybook project",
  breadcrumbs,
  className,
}: PropsWithChildren<{
  projectId?: string
  organizationId?: string
  prefix?: string
  title?: string
  breadcrumbs?: { label: string; href: string }[]
  className?: string
}>) {
  return (
    <ProjectScopeProvider
      projectId={projectId}
      organizationId={organizationId}
      prefix={prefix}
    >
      <PageLayout
        title={title}
        breadcrumbs={breadcrumbs}
        className={cn(
          "h-[min(720px,100dvh)] min-h-96 overflow-hidden",
          className
        )}
      >
        {children}
      </PageLayout>
    </ProjectScopeProvider>
  )
}
