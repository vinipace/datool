import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import { traceDetail } from "../../.storybook/scenarios/traces/fixtures"
import { ProjectScope } from "./project-scope-context"
import { reactViewHandlers } from "../../.storybook/scenarios/react-views"
import { http, HttpResponse, delay } from "msw"
import { ReactTraceViews } from "./react-trace-views"

const meta = {
  title: "Tracer/ReactTraceViews",
  component: ReactTraceViews,
  decorators: [
    (Story) => (
      <div className="h-[480px] w-full border border-border">
        <ProjectScope.Provider
          value={{
            projectId: "storybook-project",
            organizationId: "storybook-organization",
          }}
        >
          <Story />
        </ProjectScope.Provider>
      </div>
    ),
  ],
  args: { trace: traceDetail },
  parameters: { msw: { handlers: reactViewHandlers() } },
} satisfies Meta<typeof ReactTraceViews>

export default meta
type Story = StoryObj<typeof meta>

export const EmptyLibrary: Story = {
  loaders: [
    async () => {
      localStorage.removeItem("datool:project-react-view:storybook-project")
      return {}
    },
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await expect(
      canvas.findByText("Create a view from the view menu to get started.")
    ).resolves.toBeVisible()
    await userEvent.click(canvas.getByRole("combobox", { name: "React view" }))
    await expect(
      body.findByRole("button", { name: "Create new view" })
    ).resolves.toBeVisible()
  },
}

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/react-views", async () => {
          await delay("infinite")
          return HttpResponse.json({ data: { items: [], nextCursor: null } })
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("Loading views…")
    ).resolves.toBeVisible()
  },
}
export const LoadError: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/react-views", () =>
          HttpResponse.json(
            { error: { message: "Project library unavailable" } },
            { status: 503 }
          )
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Project library unavailable"
    )
    await expect(
      canvas.getByRole("button", { name: "Reload views" })
    ).toBeVisible()
  },
}
