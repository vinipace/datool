import { ProjectScopeProvider } from "@/components/tracer/project-scope"
import { notFound } from "next/navigation"
import { requireActiveOrganization } from "@/lib/workspace-access"
import { getProjectByOrganizationSlug } from "@/lib/project-access"
import { TracerAppShell } from "@/components/tracer/app-shell"
export default async function Layout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ projectSlug: string }>
}) {
  const { projectSlug } = await params
  const { organization, user } = await requireActiveOrganization(
    `/p/${encodeURIComponent(projectSlug)}`
  )
  const project = await getProjectByOrganizationSlug(
    projectSlug,
    organization.id
  )
  if (!project) notFound()
  const prefix = `/p/${encodeURIComponent(project.slug)}`
  return (
    <ProjectScopeProvider
      projectId={project.id}
      prefix={prefix}
      organizationId={organization.id}
    >
      <TracerAppShell
        key={project.id}
        organization={organization}
        user={user}
        project={{ id: project.id, name: project.name, slug: project.slug }}
      >
        {children}
      </TracerAppShell>
    </ProjectScopeProvider>
  )
}
