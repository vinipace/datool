import { getRouter } from "@storybook/nextjs-vite/navigation.mock"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  StorybookProjectFrame,
  storybookProject,
} from "../../.storybook/component-frame"
import { storybookDashboard } from "../../.storybook/scenarios/dashboards/fixtures"
import {
  dashboardCatalogHandler,
  dashboardDetailHandler,
  dashboardDetailHandlers,
  dashboardMutationHandlers,
  metricsBatchHandler,
} from "../../.storybook/scenarios/dashboards/handlers"
import { DashboardDetailPage } from "./dashboard-detail-page"
import { ProjectPageLoading } from "./workspace-loading"
import { http, HttpResponse } from "msw"
import { dashboardTemplates } from "@/src/lib/tracer/dashboard-templates"
import {
  semanticQuerySchema,
  type NormalizedSemanticQuery,
} from "@/src/lib/semantic/query"
import { semanticResultForQuery } from "../../.storybook/scenarios/dashboards/fixtures"

function DetailScenario() {
  return (
    <StorybookProjectFrame
      title="Dashboard"
      breadcrumbs={[
        { label: "Dashboards", href: `${storybookProject.prefix}/dashboards` },
      ]}
    >
      <DashboardDetailPage dashboardId={storybookDashboard.id} />
    </StorybookProjectFrame>
  )
}

const meta = {
  title: "Tracer/Dashboards/DashboardDetailPage",
  component: DashboardDetailPage,
  args: { dashboardId: storybookDashboard.id },
  parameters: {
    layout: "fullscreen",
    nextjs: {
      navigation: {
        pathname: `${storybookProject.prefix}/dashboards/${storybookDashboard.id}`,
      },
    },
  },
  render: () => <DetailScenario />,
} satisfies Meta<typeof DashboardDetailPage>

export default meta
type Story = StoryObj<typeof meta>

async function chooseDashboardAction(canvasElement: HTMLElement, name: string) {
  await userEvent.click(
    await within(canvasElement).findByRole("button", { name: "More actions" })
  )
  await userEvent.click(
    await within(canvasElement.ownerDocument.body).findByRole("menuitem", {
      name,
    })
  )
}

export const Populated: Story = {
  parameters: { msw: { handlers: dashboardDetailHandlers() } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("heading", { name: "Observability overview" })
    ).resolves.toBeVisible()
    const header = within(canvas.getByRole("banner", { name: "Page controls" }))
    await expect(header.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Observability overview"
    )
    await expect(
      header.getByRole("link", { name: "Dashboards" })
    ).toHaveAttribute("href", `${storybookProject.prefix}/dashboards`)
    const controls = within(
      canvas.getByRole("group", { name: "Dashboard controls" })
    )
    await expect(
      controls.getByRole("textbox", { name: "Dashboard name" })
    ).toHaveAttribute("readonly")
    await expect(
      controls.getByRole("search", { name: "Filter traces" })
    ).toBeVisible()
    await expect(header.queryByRole("search")).not.toBeInTheDocument()
    await expect(
      canvas.findByText("Trace volume", { exact: true })
    ).resolves.toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: "Clone dashboard" })
    ).not.toBeInTheDocument()
    await expect(
      canvas.queryByRole("button", { name: "Edit dashboard" })
    ).not.toBeInTheDocument()
    await userEvent.click(header.getByRole("button", { name: "More actions" }))
    const menu = within(
      await within(canvasElement.ownerDocument.body).findByRole("menu")
    )
    await expect(menu.getByText("Saved")).toBeVisible()
    await expect(
      menu.getByRole("menuitem", { name: "Edit dashboard" })
    ).toBeVisible()
    await expect(
      menu.getByRole("menuitem", { name: "Clone dashboard" })
    ).toBeVisible()
    await expect(
      menu.getByRole("menuitem", { name: "Delete dashboard" })
    ).toBeVisible()
    await expect(menu.queryByText("Export loaded rows")).not.toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
  },
}

const evaluationDashboard = {
  ...storybookDashboard,
  ...dashboardTemplates
    .find((template) => template.id === "eval-quality-by-model")!
    .create(),
}
let evaluationQueries: NormalizedSemanticQuery[] = []
const evaluationHandlers = () => [
  dashboardDetailHandler("populated", { dashboard: evaluationDashboard }),
  dashboardCatalogHandler(),
  http.post("/api/metrics/batch", async ({ request }) => {
    const body = (await request.json()) as { queries: unknown[] }
    evaluationQueries = body.queries.map((query) =>
      semanticQuerySchema.parse(query)
    )
    return HttpResponse.json({
      data: evaluationQueries.map((query) => semanticResultForQuery(query)),
    })
  }),
]

export const EvaluationWorkflowFilter: Story = {
  parameters: {
    nextjs: {
      navigation: { query: { filter: "startedAt >= -7d" } },
    },
    msw: { handlers: evaluationHandlers() },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const bar = within(
      await canvas.findByRole("search", { name: "Filter evaluations" })
    )
    await expect(
      canvas.findByText("Average score", { exact: true })
    ).resolves.toBeVisible()
    await expect(
      canvas.queryByRole("combobox", { name: "Filter by workflow or agent" })
    ).not.toBeInTheDocument()
    const input = bar.getByRole("combobox", { name: "Filter expression" })
    for (const [field, label] of [
      ["workflow", "Workflow"],
      ["agent", "Agent"],
      ["groupName", "Operation name"],
    ]) {
      if (field === "groupName") {
        await userEvent.type(input, "Operation")
        await userEvent.click(
          await within(canvasElement.ownerDocument.body).findByRole("option", {
            name: "Operation name =",
          })
        )
        await userEvent.keyboard('"Customer answers"')
      } else {
        await userEvent.type(input, `${field} = "Customer answers"`)
      }
      await userEvent.keyboard("{Enter}")
      await waitFor(() => {
        expect(evaluationQueries.length).toBeGreaterThan(0)
        for (const query of evaluationQueries) {
          expect(query.filters).toContainEqual({
            member: `evalResults.${field}`,
            operator: "equals",
            values: ["Customer answers"],
          })
        }
        expect(
          new URL(window.location.href).searchParams.get("filter")
        ).toContain(`${field} = "Customer answers"`)
      })
      await expect(
        bar.getByRole("button", { name: "Edit Past 7 days" })
      ).toBeVisible()
      await userEvent.click(
        bar.getByRole("button", {
          name: `Remove ${label}: "Customer answers"`,
        })
      )
      await waitFor(() =>
        expect(
          evaluationQueries.every(
            (query) =>
              !query.filters.some(
                (filter) =>
                  "member" in filter && filter.member === `evalResults.${field}`
              )
          )
        ).toBe(true)
      )
    }
    await expect(
      bar.getByRole("button", { name: "Edit Past 7 days" })
    ).toBeVisible()
  },
}

export const DateFilterFromUrl: Story = {
  parameters: {
    nextjs: { navigation: { query: { filter: "startedAt >= -30d" } } },
    msw: { handlers: dashboardDetailHandlers() },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("button", { name: "Edit Past 30 days" })
    ).resolves.toBeVisible()
    await expect(
      canvas.findByText("Trace volume", { exact: true })
    ).resolves.toBeVisible()
  },
}

export const ClearedDateFilterFromUrl: Story = {
  parameters: {
    nextjs: { navigation: { query: { filter: "" } } },
    msw: { handlers: dashboardDetailHandlers() },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("search", { name: "Filter traces" })
    ).resolves.toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: /Edit Past/ })
    ).not.toBeInTheDocument()
    await expect(
      canvas.queryByRole("button", { name: "Clear search" })
    ).not.toBeInTheDocument()
  },
}

export const Loading: Story = {
  parameters: { msw: { handlers: dashboardDetailHandlers("loading") } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("status")
    ).resolves.toHaveAttribute("aria-busy", "true")
    await expect(
      canvasElement.querySelectorAll('[data-slot="dashboard-widget-skeleton"]')
    ).toHaveLength(6)
    await expect(
      within(canvasElement).queryByRole("table")
    ).not.toBeInTheDocument()
  },
}

export const RouteLoading: Story = {
  render: () => (
    <StorybookProjectFrame title="Dashboard">
      <ProjectPageLoading />
    </StorybookProjectFrame>
  ),
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("status", { name: "Loading dashboard" })
    ).resolves.toBeVisible()
    await expect(
      canvasElement.querySelectorAll('[data-slot="dashboard-widget-skeleton"]')
    ).toHaveLength(6)
    await expect(
      canvasElement.querySelector('[data-slot="collection-table-skeleton"]')
    ).toBeNull()
  },
}

export const ErrorAndRetry: Story = {
  parameters: {
    msw: {
      handlers: [
        dashboardDetailHandler("error", { once: true }),
        dashboardDetailHandler(),
        dashboardCatalogHandler(),
        metricsBatchHandler(),
        ...dashboardMutationHandlers(),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Dashboard could not be loaded."
    )
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }))
    await expect(
      canvas.findByRole("heading", { name: "Observability overview" })
    ).resolves.toBeVisible()
  },
}

export const Edit: Story = {
  parameters: { msw: { handlers: dashboardDetailHandlers() } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("heading", { name: "Observability overview" })
    await chooseDashboardAction(canvasElement, "Edit dashboard")
    const editing = within(
      canvas.getByRole("group", { name: "Dashboard editing" })
    )
    await expect(
      editing.findByRole("combobox", { name: "Add widget" })
    ).resolves.toBeVisible()
    await expect(
      editing.getByRole("button", { name: "Done editing" })
    ).toBeVisible()
    await expect(
      editing.getByRole("textbox", { name: "Dashboard name" })
    ).not.toHaveAttribute("readonly")
    await expect(
      canvas.queryByRole("search", { name: "Filter traces" })
    ).not.toBeInTheDocument()
  },
}

export const EmptyCanvas: Story = {
  parameters: {
    msw: {
      handlers: [
        dashboardCatalogHandler(),
        metricsBatchHandler(),
        ...dashboardMutationHandlers({
          initial: { ...storybookDashboard, widgets: [] },
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("Add a widget to start arranging your canvas.")
    ).resolves.toBeVisible()
    await waitFor(() =>
      expect(canvas.getByRole("combobox", { name: "Add widget" })).toBeEnabled()
    )
    await userEvent.click(canvas.getByRole("combobox", { name: "Add widget" }))
    await userEvent.click(
      await within(canvasElement.ownerDocument.body).findByRole("option", {
        name: "Metric tile",
      })
    )
    await expect(
      canvas.findByRole("button", { name: "Edit Traces" })
    ).resolves.toBeVisible()
    await waitFor(() =>
      expect(
        canvas.getByRole("status", { name: "Dashboard save status" })
      ).toHaveTextContent("Saved")
    )
  },
}

export const AddDonut: Story = {
  parameters: {
    msw: {
      handlers: [
        dashboardCatalogHandler(),
        metricsBatchHandler(),
        ...dashboardMutationHandlers({
          initial: { ...storybookDashboard, widgets: [] },
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const add = await canvas.findByRole("combobox", { name: "Add widget" })
    await waitFor(() => expect(add).toBeEnabled())
    await userEvent.click(add)
    await userEvent.click(
      await within(canvasElement.ownerDocument.body).findByRole("option", {
        name: "Donut chart",
      })
    )
    await expect(
      canvas.findByRole("group", { name: "Traces donut chart" })
    ).resolves.toBeVisible()
    await waitFor(() =>
      expect(
        canvas.getByRole("status", { name: "Dashboard save status" })
      ).toHaveTextContent("Saved")
    )
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  },
}

export const CanvasAutosave: Story = {
  parameters: { msw: { handlers: dashboardDetailHandlers() } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await chooseDashboardAction(canvasElement, "Edit dashboard")
    await userEvent.click(
      canvas.getByRole("button", { name: "Edit Trace volume" })
    )
    const title = canvas.getByRole("textbox", { name: "Title" })
    await userEvent.clear(title)
    await expect(canvas.getByRole("alert")).toHaveTextContent("not been saved")
    await userEvent.type(title, "Requests today")
    await expect(
      canvas.getByRole("button", { name: "Edit Requests today" })
    ).toBeVisible()
    await userEvent.click(
      canvas.getByRole("combobox", { name: "Visualization" })
    )
    await userEvent.click(
      await within(canvasElement.ownerDocument.body).findByRole("option", {
        name: "Line chart",
      })
    )
    await waitFor(() =>
      expect(
        canvas.getByRole("status", { name: "Dashboard save status" })
      ).toHaveTextContent("Saved")
    )
    await userEvent.keyboard("{Escape}")
    await expect(canvas.queryByRole("complementary")).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("button", { name: "Done editing" }))
    await expect(
      canvas.getByRole("textbox", { name: "Dashboard name" })
    ).toHaveAttribute("readonly")
    await expect(
      canvas.getByRole("search", { name: "Filter traces" })
    ).toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "Edit Past 3 days" })
    ).toBeVisible()
    await expect(
      within(canvas.getByLabelText("Dashboard widgets")).queryByRole("button", {
        name: /^Remove /,
      })
    ).not.toBeInTheDocument()
    await expect(
      canvas.getByText("Requests today", { exact: true })
    ).toBeVisible()
  },
}

export const SaveError: Story = {
  parameters: {
    msw: {
      handlers: [
        dashboardCatalogHandler(),
        metricsBatchHandler(),
        ...dashboardMutationHandlers({ saveError: "Connection interrupted." }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await chooseDashboardAction(canvasElement, "Edit dashboard")
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Dashboard name" }),
      " Keep this draft"
    )
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Connection interrupted"
    )
    await expect(
      canvas.getByRole("button", { name: "Retry saving" })
    ).toBeVisible()
    await expect(
      canvas.getByRole("textbox", { name: "Dashboard name" })
    ).toHaveValue(`${storybookDashboard.name} Keep this draft`)
  },
}

export const RevisionConflict: Story = {
  parameters: {
    msw: {
      handlers: [
        dashboardCatalogHandler(),
        metricsBatchHandler(),
        ...dashboardMutationHandlers({ conflict: true }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await chooseDashboardAction(canvasElement, "Edit dashboard")
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Dashboard name" }),
      " Local edit"
    )
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "changed elsewhere"
    )
    await expect(
      canvas.getByRole("button", { name: "Reload latest version" })
    ).toBeVisible()
  },
}

export const CloneFromHeader: Story = {
  parameters: { msw: { handlers: dashboardDetailHandlers() } },
  play: async ({ canvasElement }) => {
    getRouter().push.mockClear()
    await chooseDashboardAction(canvasElement, "Clone dashboard")
    await waitFor(() =>
      expect(getRouter().push).toHaveBeenCalledWith(
        `${storybookProject.prefix}/dashboards/dash_storybook_created`
      )
    )
  },
}

export const DeleteFromHeader: Story = {
  parameters: { msw: { handlers: dashboardDetailHandlers() } },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    getRouter().replace.mockClear()
    await chooseDashboardAction(canvasElement, "Delete dashboard")
    let dialog = await body.findByRole("alertdialog")
    const cancel = within(dialog).getByRole("button", { name: "Cancel" })
    await waitFor(() => expect(cancel).toHaveFocus())
    await userEvent.click(cancel)
    await waitFor(() =>
      expect(
        within(canvasElement).getByRole("button", { name: "More actions" })
      ).toHaveFocus()
    )
    await expect(getRouter().replace).not.toHaveBeenCalled()
    await chooseDashboardAction(canvasElement, "Delete dashboard")
    dialog = await body.findByRole("alertdialog")
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete dashboard" })
    )
    await waitFor(() =>
      expect(getRouter().replace).toHaveBeenCalledWith(
        `${storybookProject.prefix}/dashboards`
      )
    )
  },
}
