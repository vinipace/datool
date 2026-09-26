import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { useProjectScope } from "./project-scope-context"
import { ProjectScopeProvider } from "./project-scope"

function ScopeReadout() {
  const scope = useProjectScope()
  return (
    <dl className="grid grid-cols-2 gap-2 rounded border border-border bg-muted p-4 text-sm">
      <dt className="text-foreground-muted">Organization</dt>
      <dd>{scope?.organizationId}</dd>
      <dt className="text-foreground-muted">Project</dt>
      <dd>{scope?.projectId}</dd>
    </dl>
  )
}

function ScopeExample() {
  return (
    <ProjectScopeProvider
      organizationId="org-storybook"
      prefix="/p/demo"
      projectId="project-storybook"
    >
      <ScopeReadout />
    </ProjectScopeProvider>
  )
}

const meta = {
  title: "Tracer/ProjectScopeProvider",
  component: ProjectScopeProvider,
  render: () => <ScopeExample />,
} satisfies Meta<typeof ProjectScopeProvider>

export default meta
type Story = StoryObj<typeof ScopeExample>

export const Scoped: Story = {}
