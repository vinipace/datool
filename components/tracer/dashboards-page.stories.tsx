import { isDashboardDataWidget } from "@/src/lib/tracer/dashboards"
import {
  checkCollectionSelection,
  checkCollectionPanel,
  checkCompactCollectionPanel,
} from "../../.storybook/collection-panel-checks"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { getRouter } from "@storybook/nextjs-vite/navigation.mock"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { delay, http } from "msw"
import {
  StorybookProjectFrame,
  storybookProject,
} from "../../.storybook/component-frame"
import {
  apiError,
  dashboardPageHandlers,
  envelope,
} from "../../.storybook/scenarios/dashboards/handlers"
import { dashboardInputSchema } from "@/src/lib/tracer/dashboards"
import { DashboardsPage } from "./dashboards-page"

function DashboardsScenario() {
  return (
    <StorybookProjectFrame title="Dashboards">
      <DashboardsPage />
    </StorybookProjectFrame>
  )
}

const meta = {
  title: "Tracer/Dashboards/DashboardsPage",
  component: DashboardsPage,
  parameters: {
    layout: "fullscreen",
    nextjs: {
      navigation: { pathname: `${storybookProject.prefix}/dashboards` },
    },
  },
  render: () => <DashboardsScenario />,
} satisfies Meta<typeof DashboardsPage>

export default meta
type Story = StoryObj<typeof meta>

export const PopulatedSelectionAndSearch: Story = {
  parameters: { msw: { handlers: dashboardPageHandlers() } },
  play: async ({ canvasElement }) => {
    await checkCollectionPanel(canvasElement, "Dashboards")
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("Observability overview")
    ).resolves.toBeVisible()
    const selectAll = canvas.getByRole("checkbox", {
      name: "Select all dashboards",
    })
    await userEvent.click(selectAll)
    await expect(selectAll).toBeChecked()
    await userEvent.click(
      canvas.getByRole("button", { name: /Clear selection/ })
    )

    const search = canvas.getByRole("textbox", { name: "Search dashboards" })
    await userEvent.type(search, "quality")
    await expect(canvas.findByText("Quality overview")).resolves.toBeVisible()
    await expect(
      canvas.queryByText("Observability overview")
    ).not.toBeInTheDocument()
  },
}

export const Empty: Story = {
  parameters: { msw: { handlers: dashboardPageHandlers("empty") } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText(
        "No dashboards yet. Create one to start exploring your data."
      )
    ).resolves.toBeVisible()
  },
}

export const Loading: Story = {
  parameters: { msw: { handlers: dashboardPageHandlers("loading") } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("status")
    ).resolves.toHaveTextContent("Loading dashboards")
  },
}

export const Error: Story = {
  parameters: { msw: { handlers: dashboardPageHandlers("error") } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("alert")
    ).resolves.toHaveTextContent("Dashboards are unavailable.")
  },
}

const created = fn()
function creationHandler(
  mode: "success" | "retry" | "pending" | "error" = "success"
) {
  return http.post("/api/dashboards", async ({ request }) => {
    const input = dashboardInputSchema.parse(await request.json())
    created(input)
    if (mode === "pending") await delay("infinite")
    if (
      mode === "error" ||
      (mode === "retry" && created.mock.calls.length === 1)
    )
      return apiError("Unable to create dashboard. Please try again.")
    return envelope({ ...input, id: "dash_from_template", revision: 1 })
  })
}

async function openCreation(canvasElement: HTMLElement) {
  await userEvent.click(
    within(canvasElement).getByRole("button", { name: "New dashboard" })
  )
  return within(
    await within(canvasElement.ownerDocument.body).findByRole("dialog", {
      name: "New dashboard",
    })
  )
}

export const TemplateLibrary: Story = {
  parameters: {
    msw: { handlers: [creationHandler(), ...dashboardPageHandlers("empty")] },
  },
  beforeEach: () => {
    created.mockClear()
  },
  play: async ({ canvasElement }) => {
    const dialog = await openCreation(canvasElement)
    await expect(
      dialog.getByRole("radio", { name: "Blank dashboard" })
    ).toBeChecked()
    await expect(dialog.getAllByRole("radio")).toHaveLength(7)
    await expect(
      dialog.getByRole("radio", { name: "Evaluation quality by model" })
    ).toBeVisible()
    await userEvent.click(dialog.getByRole("radio", { name: "Weekly health" }))
    await expect(
      dialog.getByRole("textbox", { name: "Dashboard name" })
    ).toHaveValue("Weekly health")
    await expect(created).not.toHaveBeenCalled()
  },
}

export const CreateBlankDashboard: Story = {
  parameters: {
    msw: { handlers: [creationHandler(), ...dashboardPageHandlers("empty")] },
  },
  beforeEach: () => {
    created.mockClear()
    getRouter().push.mockClear()
  },
  play: async ({ canvasElement }) => {
    const dialog = await openCreation(canvasElement)
    await userEvent.click(
      dialog.getByRole("button", { name: "Create dashboard" })
    )
    await waitFor(() =>
      expect(getRouter().push).toHaveBeenCalledWith(
        `${storybookProject.prefix}/dashboards/dash_from_template`
      )
    )
    await expect(created).toHaveBeenCalledTimes(1)
    await expect(created).toHaveBeenCalledWith({
      schemaVersion: 1,
      name: "Untitled dashboard",
      description: "",
      widgets: [],
    })
  },
}

export const CreateFromTemplate: Story = {
  parameters: {
    msw: { handlers: [creationHandler(), ...dashboardPageHandlers()] },
  },
  beforeEach: () => {
    created.mockClear()
    getRouter().push.mockClear()
  },
  play: async ({ canvasElement }) => {
    const dialog = await openCreation(canvasElement)
    await userEvent.click(dialog.getByRole("radio", { name: "Cost and usage" }))
    const name = dialog.getByRole("textbox", { name: "Dashboard name" })
    await userEvent.clear(name)
    await userEvent.type(name, "  Production spend  ")
    // Switching templates preserves a user-entered name.
    await userEvent.click(dialog.getByRole("radio", { name: "LLM overview" }))
    await expect(name).toHaveValue("  Production spend  ")
    await userEvent.click(dialog.getByRole("radio", { name: "Cost and usage" }))
    await userEvent.click(
      dialog.getByRole("button", { name: "Create dashboard" })
    )
    await waitFor(() =>
      expect(getRouter().push).toHaveBeenCalledWith(
        `${storybookProject.prefix}/dashboards/dash_from_template`
      )
    )
    await expect(created).toHaveBeenCalledTimes(1)
    const config = dashboardInputSchema.parse(created.mock.calls[0][0])
    await expect(config.name).toBe("Production spend")
    await expect(config.defaultWindowDays).toBe(7)
    await expect(config.widgets).toHaveLength(10)
    await expect(
      config.widgets
        .filter(isDashboardDataWidget)
        .flatMap((widget) => widget.query.dimensions)
    ).toEqual(expect.arrayContaining(["logs.functionName"]))
    await expect(
      config.widgets.filter(isDashboardDataWidget)[0].query.measures
    ).toEqual(["logs.costUsd"])
    await expect(
      config.widgets.filter(isDashboardDataWidget)[0].query.timeDimensions[0]
        .dateRange[1]
    ).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  },
}

export const CreateEvaluationsDashboard: Story = {
  parameters: {
    msw: { handlers: [creationHandler(), ...dashboardPageHandlers()] },
  },
  beforeEach: () => {
    created.mockClear()
    getRouter().push.mockClear()
  },
  play: async ({ canvasElement }) => {
    const dialog = await openCreation(canvasElement)
    await userEvent.click(dialog.getByRole("radio", { name: "Evaluations" }))
    await expect(
      dialog.getByRole("textbox", { name: "Dashboard name" })
    ).toHaveValue("Evaluations")
    await userEvent.click(
      dialog.getByRole("button", { name: "Create dashboard" })
    )
    await waitFor(() =>
      expect(getRouter().push).toHaveBeenCalledWith(
        `${storybookProject.prefix}/dashboards/dash_from_template`
      )
    )
    await expect(created).toHaveBeenCalledTimes(1)
    const config = created.mock.calls[0][0]
    await expect(config.widgets).toHaveLength(16)
    await expect(
      config.widgets.filter(isDashboardDataWidget)[0].query.timeDimensions[0]
        .dimension
    ).toBe("evalRuns.createdAt")
    await expect(config.widgets[2].query.measures).toEqual([
      "scores.explicitPassRate",
    ])
    await expect(config.widgets[2].query.timeDimensions[0].dimension).toBe(
      "scores.completedAt"
    )
  },
}

export const KeyboardCancelAndReopen: Story = {
  parameters: {
    msw: { handlers: [creationHandler(), ...dashboardPageHandlers()] },
  },
  beforeEach: () => {
    created.mockClear()
  },
  play: async ({ canvasElement }) => {
    let dialog = await openCreation(canvasElement)
    await expect(
      dialog.getByRole("radio", { name: "Blank dashboard" })
    ).toHaveFocus()
    await userEvent.keyboard("{ArrowDown}")
    await expect(
      dialog.getByRole("radio", { name: "Weekly health" })
    ).toBeChecked()
    await expect(
      dialog.getByRole("radio", { name: "Weekly health" })
    ).toHaveFocus()
    await userEvent.keyboard("{Escape}")
    await expect(
      within(canvasElement).getByRole("button", { name: "New dashboard" })
    ).toHaveFocus()
    dialog = await openCreation(canvasElement)
    await expect(
      dialog.getByRole("radio", { name: "Blank dashboard" })
    ).toBeChecked()
    const name = dialog.getByRole("textbox", { name: "Dashboard name" })
    await userEvent.clear(name)
    await userEvent.type(name, "   ")
    await expect(
      dialog.getByRole("button", { name: "Create dashboard" })
    ).toBeDisabled()
    await userEvent.click(dialog.getByRole("button", { name: "Cancel" }))
    await expect(created).not.toHaveBeenCalled()
  },
}

export const CreationErrorAndRetry: Story = {
  parameters: {
    msw: { handlers: [creationHandler("retry"), ...dashboardPageHandlers()] },
  },
  beforeEach: () => {
    created.mockClear()
    getRouter().push.mockClear()
  },
  play: async ({ canvasElement }) => {
    const dialog = await openCreation(canvasElement)
    await userEvent.click(dialog.getByRole("radio", { name: "Weekly health" }))
    await userEvent.click(
      dialog.getByRole("button", { name: "Create dashboard" })
    )
    await expect(dialog.findByRole("alert")).resolves.toHaveTextContent(
      "Unable to create dashboard. Please try again."
    )
    await expect(
      dialog.getByRole("radio", { name: "Weekly health" })
    ).toBeChecked()
    await expect(
      dialog.getByRole("textbox", { name: "Dashboard name" })
    ).toHaveValue("Weekly health")
    await expect(getRouter().push).not.toHaveBeenCalled()
    await userEvent.click(
      dialog.getByRole("button", { name: "Create dashboard" })
    )
    await waitFor(() => expect(getRouter().push).toHaveBeenCalled())
    await expect(created).toHaveBeenCalledTimes(2)
  },
}

export const CreationPending: Story = {
  parameters: {
    msw: { handlers: [creationHandler("pending"), ...dashboardPageHandlers()] },
  },
  beforeEach: () => {
    created.mockClear()
  },
  play: async ({ canvasElement }) => {
    const dialog = await openCreation(canvasElement)
    await userEvent.click(
      dialog.getByRole("button", { name: "Create dashboard" })
    )
    await expect(
      dialog.getByRole("button", { name: "Creating dashboard…" })
    ).toBeDisabled()
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled()
    await expect(
      dialog.getByRole("textbox", { name: "Dashboard name" })
    ).toBeDisabled()
    for (const radio of dialog.getAllByRole("radio"))
      await expect(radio).toBeDisabled()
    await userEvent.keyboard("{Escape}{Enter}")
    await expect(
      dialog.getByRole("button", { name: "Creating dashboard…" })
    ).toBeVisible()
    await waitFor(() => expect(created).toHaveBeenCalledTimes(1))
  },
}

export const CreationFailed: Story = {
  parameters: {
    msw: { handlers: [creationHandler("error"), ...dashboardPageHandlers()] },
  },
  beforeEach: () => {
    created.mockClear()
  },
  play: async ({ canvasElement }) => {
    const dialog = await openCreation(canvasElement)
    await userEvent.click(dialog.getByRole("radio", { name: "Weekly health" }))
    await userEvent.click(
      dialog.getByRole("button", { name: "Create dashboard" })
    )
    await expect(dialog.findByRole("alert")).resolves.toHaveTextContent(
      "Unable to create dashboard. Please try again."
    )
    await expect(
      dialog.getByRole("button", { name: "Create dashboard" })
    ).toBeEnabled()
  },
}

export const NarrowCollection: Story = {
  parameters: PopulatedSelectionAndSearch.parameters,
  render: () => (
    <div className="w-[375px] max-w-full">
      <DashboardsScenario />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await checkCompactCollectionPanel(canvasElement, "Dashboards")
  },
}

export const SelectionHeader: Story = {
  ...PopulatedSelectionAndSearch,
  play: async ({ canvasElement }) => {
    await userEvent.type(
      await within(canvasElement).findByRole("textbox", {
        name: "Search dashboards",
      }),
      "overview"
    )
    await checkCollectionSelection(canvasElement, "Dashboards")
  },
}

export const NarrowSelectionHeader: Story = {
  ...NarrowCollection,
  play: async ({ canvasElement }) =>
    checkCollectionSelection(canvasElement, "Dashboards"),
}
