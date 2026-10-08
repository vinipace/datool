import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { traceDetail } from "../../.storybook/scenarios/traces/fixtures"
import { ProjectScope } from "./project-scope-context"
import { storybookReactView } from "../../.storybook/scenarios/react-views"
import type { ReactView } from "@/src/lib/tracer/react-views"
import { http, HttpResponse, delay } from "msw"
import { ReactTraceViews } from "./react-trace-views"

function libraryHandlers(views: ReactView[] = []) {
  return [
    http.post("/api/agent/get_view_preference", () =>
      HttpResponse.json({ data: { revision: 0, value: {} } })
    ),
    http.post("/api/agent/save_view_preference", () =>
      HttpResponse.json({ data: { revision: 1, value: {} } })
    ),
    http.get("/api/object-views", () =>
      HttpResponse.json({
        data: {
          items: views.map(({ code, ...view }) => {
            void code
            return view
          }),
          nextCursor: null,
        },
      })
    ),
    http.get("/api/object-views/:id", ({ params }) => {
      const view = views.find((view) => view.id === params.id)
      return view
        ? HttpResponse.json({ data: view })
        : HttpResponse.json(
            { error: { message: "View not found" } },
            { status: 404 }
          )
    }),
  ]
}

const galleryViews: ReactView[] = [
  { ...storybookReactView, dataMode: "summary", objectTypes: ["trace"] },
  {
    ...storybookReactView,
    id: "evidence-view",
    name: "Evidence review",
    description: "Source excerpts and confidence",
    dataMode: "summary",
    objectTypes: ["trace"],
  },
  {
    ...storybookReactView,
    id: "dataset-view",
    name: "Dataset only",
    objectTypes: ["dataset-item"],
  },
]

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
  parameters: { msw: { handlers: libraryHandlers() } },
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
    await expect(
      canvas.getByRole("textbox", { name: "Filter project views" })
    ).toBeVisible()
    await userEvent.click(canvas.getByRole("combobox", { name: "View" }))
    await expect(
      body.findByRole("button", { name: "Create new view" })
    ).resolves.toBeVisible()
  },
}

export const ViewGrid: Story = {
  parameters: { msw: { handlers: libraryHandlers(galleryViews) } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("button", { name: "Open Answer view" })
    ).resolves.toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "Open Evidence review" })
    ).toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: "Open Dataset only" })
    ).not.toBeInTheDocument()
    const filter = canvas.getByRole("textbox", { name: "Filter project views" })
    await userEvent.type(filter, "confidence")
    await expect(
      canvas.queryByRole("button", { name: "Open Answer view" })
    ).not.toBeInTheDocument()
    await expect(
      canvas.getByRole("button", { name: "Open Evidence review" })
    ).toBeVisible()
    await userEvent.clear(filter)
    await userEvent.type(filter, "missing")
    await expect(canvas.getByText("No matching views.")).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Clear filter" }))
    await userEvent.click(
      canvas.getByRole("button", { name: "Open Answer view" })
    )
    await waitFor(() =>
      expect(canvas.getByRole("combobox", { name: "View" })).toHaveTextContent(
        "Answer view"
      )
    )
    await expect(
      canvas.queryByRole("textbox", { name: "Filter project views" })
    ).not.toBeInTheDocument()
  },
}

export const NarrowViewGrid: Story = {
  parameters: { msw: { handlers: libraryHandlers(galleryViews) } },
  render: (args) => (
    <div className="w-80 max-w-full">
      <ReactTraceViews {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const first = await canvas.findByRole("button", {
      name: "Open Answer view",
    })
    const second = canvas.getByRole("button", { name: "Open Evidence review" })
    await expect(second.getBoundingClientRect().top).toBeGreaterThan(
      first.getBoundingClientRect().bottom
    )
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(
      canvasElement.clientWidth
    )
  },
}

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/object-views", async () => {
          await delay("infinite")
          return HttpResponse.json({ data: { items: [], nextCursor: null } })
        }),
        ...libraryHandlers(),
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
        http.get("/api/object-views", () =>
          HttpResponse.json(
            { error: { message: "Project library unavailable" } },
            { status: 503 }
          )
        ),
        ...libraryHandlers(),
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
