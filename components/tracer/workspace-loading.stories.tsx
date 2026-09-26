import { useState } from "react"
import { renderToString } from "react-dom/server"
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { delay, http, HttpResponse } from "msw"
import { expect, userEvent, within } from "storybook/test"
import AppLoading from "@/app/(app)/loading"
import ProjectLoading from "@/app/(app)/p/[projectSlug]/loading"
import { Button } from "@/components/ui/button"
import {
  storybookOrganization,
  storybookProject,
} from "../../.storybook/scenarios/auth-workspace/fixtures"
import {
  storybookAuthHandlers,
  workspaceProjectHandlers,
} from "../../.storybook/scenarios/auth-workspace/handlers"
import { traceHandlers } from "../../.storybook/scenarios/traces/handlers"
import { datasetsEvalsHandlers } from "../../.storybook/scenarios/datasets-evals/handlers"
import { TracerAppShell } from "./app-shell"
import { EvalsPage } from "./evals-page"
import { ProjectScopeProvider } from "./project-scope"
import { TraceListWorkspace } from "./trace-list"

const prefix = `/p/${storybookProject.slug}`

function LoadingSequence({ resource }: { resource: "traces" | "evals" }) {
  const [stage, setStage] = useState(0)
  return (
    <>
      {stage === 0 ? (
        <AppLoading />
      ) : (
        <ProjectScopeProvider
          organizationId={storybookOrganization.id}
          projectId={storybookProject.id}
          prefix={prefix}
        >
          <TracerAppShell
            organization={storybookOrganization}
            user={{ name: "Ana Martins", email: "ana@example.com", image: null }}
            project={storybookProject}
          >
            {stage === 1 ? (
              <ProjectLoading />
            ) : resource === "traces" ? (
              <TraceListWorkspace />
            ) : (
              <EvalsPage />
            )}
          </TracerAppShell>
        </ProjectScopeProvider>
      )}
      <div className="fixed right-3 bottom-3 z-50">
        <Button
          onClick={() => setStage((current) => current + 1)}
          disabled={stage === 2}
        >
          {stage === 0 ? "Show project shell" : "Load page module"}
        </Button>
      </div>
    </>
  )
}

const meta = {
  title: "Tracer/WorkspaceLoading",
  component: LoadingSequence,
  args: { resource: "traces" },
  parameters: {
    layout: "fullscreen",
    nextjs: { navigation: { pathname: `${prefix}/traces`, query: {} } },
    msw: {
      handlers: [
        http.get("/api/traces", async () => {
          await delay("infinite")
          return HttpResponse.json({ data: null })
        }),
        http.get("/api/evals", async () => {
          await delay("infinite")
          return HttpResponse.json({ data: null })
        }),
        ...traceHandlers,
        ...datasetsEvalsHandlers,
        ...storybookAuthHandlers,
        ...workspaceProjectHandlers(),
      ],
    },
  },
  beforeEach: () => {
    localStorage.removeItem("datool_sidebar_open")
  },
} satisfies Meta<typeof LoadingSequence>

export default meta
type Story = StoryObj<typeof meta>

export const TraceLoadingStages: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    const title = args.resource === "traces" ? "Traces" : "Evals"
    const geometry = () => {
      const headers = canvas.getAllByRole("banner", { name: "Page controls" })
      expect(headers).toHaveLength(1)
      expect(
        within(headers[0]).getByRole("heading", { name: title, level: 1 })
      ).toBeVisible()
      const header = headers[0].getBoundingClientRect()
      const table = canvasElement
        .querySelector('[data-slot="collection-table-skeleton"]')!
        .getBoundingClientRect()
      const histogram = canvasElement.querySelector(
        '[data-slot="collection-histogram-skeleton"]'
      )
      expect(!!histogram).toBe(args.resource === "traces")
      return {
        headerTop: header.top,
        headerHeight: header.height,
        tableTop: table.top,
        tableWidth: table.width,
      }
    }
    const initial = geometry()
    await expect(initial.headerTop).toBe(0)
    await expect(initial.headerHeight).toBe(40)
    for (const action of ["Show project shell", "Load page module"]) {
      await userEvent.click(canvas.getByRole("button", { name: action }))
      await expect(geometry()).toEqual(initial)
    }
    const header = canvas.getByRole("banner", { name: "Page controls" })
    await userEvent.click(
      within(header).getByRole("button", { name: "Toggle sidebar" })
    )
    await expect(canvas.getByRole("link", { name: "Traces" })).toBeVisible()
  },
}

export const EvalsLoadingStages: Story = {
  ...TraceLoadingStages,
  args: { resource: "evals" },
  parameters: {
    nextjs: { navigation: { pathname: `${prefix}/evals`, query: {} } },
  },
}

export const NarrowTraceLoadingStages: Story = {
  ...TraceLoadingStages,
  render: (args) => (
    <div className="w-[375px] max-w-full">
      <LoadingSequence {...args} />
    </div>
  ),
}

export const ServerRenderedWorkspaceFallback: Story = {
  render: () => (
    <div
      dangerouslySetInnerHTML={{
        __html: renderToString(
          <PathnameContext.Provider value={`${prefix}/traces`}>
            <AppLoading />
          </PathnameContext.Provider>
        ),
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const header = canvas.getByRole("banner", { name: "Page controls" })
    await expect(
      within(header).getByRole("heading", { name: "Traces" })
    ).toBeVisible()
    await expect(header.getBoundingClientRect().height).toBe(40)
    await expect(header.getBoundingClientRect().top).toBe(0)
    await expect(within(header).queryByRole("button")).not.toBeInTheDocument()
    const toolbar = canvasElement.querySelector(
      '[data-slot="collection-toolbar-skeleton"]'
    )!
    await expect(toolbar.getBoundingClientRect().top).toBe(
      header.getBoundingClientRect().bottom
    )
    await expect(toolbar.getBoundingClientRect().width).toBe(
      canvasElement.clientWidth
    )
    await expect(
      canvasElement.querySelector('[data-slot="collection-histogram-skeleton"]')
    ).toBeVisible()
    const frame = header.parentElement!
    await expect(frame.scrollHeight).toBe(frame.clientHeight)
  },
}
