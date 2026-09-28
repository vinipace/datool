import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { getRouter } from "@storybook/nextjs-vite/navigation.mock"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { delay, http } from "msw"
import {
  StorybookProjectFrame,
  storybookProject,
} from "../../.storybook/component-frame"
import { checkCollectionPanel } from "../../.storybook/collection-panel-checks"
import {
  apiError,
  envelope,
  dashboardCatalogHandler,
  dashboardListHandler,
  dashboardDetailHandler,
  metricsBatchHandler,
  metricsQueryHandler,
  customViewsHandler,
  customFieldsHandler,
} from "../../.storybook/scenarios/dashboards/handlers"
import {
  semanticResultForQuery,
  storybookDashboard,
} from "../../.storybook/scenarios/dashboards/fixtures"
import { dashboardDataWidgetSchema } from "@/src/lib/tracer/dashboards"
import { reportTemplates } from "@/src/lib/tracer/report-templates"
import { reportInputSchema, type Report } from "@/src/lib/tracer/reports"
import { dashboardQueryPlan } from "@/src/lib/tracer/dashboard-query-plan"
import { Button } from "@/components/ui/button"
import { ReportsPage } from "./reports-page"
import { NewReportPage } from "./new-report-page"
import { ReportDetailPage } from "./report-detail-page"
import { DashboardRenderer } from "./dashboard-renderer"

const config = reportTemplates[0].create()
config.widgets = [
  {
    id: "findings",
    type: "text",
    title: "Findings",
    width: 3,
    content:
      "## Candidate comparison\n\nThe latest prompt improves the selected scorer. Missing observations stay empty.",
  },
  {
    ...dashboardDataWidgetSchema.parse(config.widgets[1]),
    query: {
      ...dashboardDataWidgetSchema.parse(config.widgets[1]).query,
      dimensions: ["evalResults.promptVersion", "evalResults.datasetId"],
    },
  },
]
const plan = dashboardQueryPlan(config.widgets, {})
const results = plan.batches.flat().map((query) => {
  const result = semanticResultForQuery(query)
  result.annotation.measures["evalResults.meanScore"].format = "percent"
  result.data = Array.from({ length: 26 }, (_, row) =>
    Array.from({ length: 13 }, (_, column) => ({
      "evalResults.promptVersion": `answer v${row + 1}`,
      "evalResults.datasetId": `Dataset ${column + 1}`,
      "evalResults.meanScore":
        row === 0 && column === 0 ? 0 : row === 0 && column === 1 ? null : 0.85,
    }))
  ).flat()
  result.meta.page.total = result.data.length
  return result
})
const report: Report = {
  id: "report-fixture",
  number: 12,
  name: "September candidates",
  description: "Comparison across the selected evaluation cases.",
  templateId: "evaluation-comparison",
  widgetCount: 2,
  createdAt: "2026-09-26T14:00:00Z",
  frozenAt: "2026-09-26T14:00:00Z",
  author: { id: "report-author", name: "Alex Morgan", kind: "session" },
  config,
  snapshot: { schemaVersion: 1, positions: plan.positions, results },
}
const { config: _config, snapshot: _snapshot, ...summary } = report
void _config
void _snapshot
const shared = [customViewsHandler(), customFieldsHandler()]
const editorNavigation = {
  pathname: `${storybookProject.prefix}/reports/new`,
  query: { template: "evaluation-comparison" },
}
const editorHandlers = [
  dashboardCatalogHandler(),
  metricsBatchHandler(),
  metricsQueryHandler(),
  ...shared,
]

const meta = {
  title: "Tracer/Reports/ReportsPage",
  component: ReportsPage,
  beforeEach: () => {
    getRouter().push.mockClear()
    getRouter().replace.mockClear()
  },
  parameters: {
    layout: "fullscreen",
    nextjs: { navigation: { pathname: `${storybookProject.prefix}/reports` } },
  },
  render: () => (
    <StorybookProjectFrame title="Reports">
      <ReportsPage />
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof ReportsPage>
export default meta
type Story = StoryObj<typeof meta>

export const Collection: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/reports", () => envelope([summary])),
        ...shared,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await checkCollectionPanel(canvasElement, "Reports")
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("September candidates")
    ).resolves.toBeVisible()
    await userEvent.click(
      canvas.getByRole("checkbox", { name: "Select all reports" })
    )
    await expect(
      canvas.getByRole("checkbox", { name: "Select all reports" })
    ).toBeChecked()
    await userEvent.click(
      canvas.getByRole("button", { name: /Clear selection/ })
    )
    await expect(
      canvas.getByRole("link", { name: "September candidates" })
    ).toHaveAttribute("href", `${storybookProject.prefix}/reports/12`)
  },
}
export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [http.get("/api/reports", () => envelope([])), ...shared],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("Create your first report")
    ).resolves.toBeVisible()
  },
}
export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/reports", async () => {
          await delay("infinite")
          return envelope([])
        }),
        ...shared,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("Loading reports")
    ).resolves.toHaveTextContent("Loading reports")
  },
}
export const Error: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/reports", () => apiError("Reports unavailable")),
        ...shared,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("Reports unavailable")
    ).resolves.toBeVisible()
  },
}
export const FrozenMatrix: Story = {
  render: () => (
    <StorybookProjectFrame title="Report">
      <ReportDetailPage reportNumber="12" />
    </StorybookProjectFrame>
  ),
  // Any live /api/metrics request fails under the shared Storybook network guard.
  parameters: {
    msw: { handlers: [http.get("/api/reports/12", () => envelope(report))] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("Candidate comparison")
    ).resolves.toBeVisible()
    await expect(canvas.findByRole("table")).resolves.toBeVisible()
    await expect(canvas.queryByText(report.description)).not.toBeInTheDocument()
    await expect(canvas.queryByText(/^Frozen /)).not.toBeInTheDocument()
    await expect(
      canvas.queryByText("Columns", { exact: true })
    ).not.toBeInTheDocument()
    const nextColumns = canvas.getByRole("button", { name: "Next columns" })
    await expect(nextColumns).toHaveTextContent("")
    const zero = canvas.getByRole("cell", { name: "0.0%" })
    await expect(zero).toHaveAttribute("data-score", "0")
    await expect(
      canvas.getAllByRole("cell", { name: "—" })[0]
    ).not.toHaveAttribute("data-score")
    await userEvent.click(canvas.getByRole("button", { name: "Next rows" }))
    await expect(canvas.findByText("answer v26")).resolves.toBeVisible()
    await expect(
      canvas.queryByText("answer v1", { exact: true })
    ).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("button", { name: "Next columns" }))
    await expect(
      canvas.findByText("Dataset 13", { exact: true })
    ).resolves.toBeVisible()
  },
}
export const TemplatePicker: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/reports", () => envelope([summary])),
        dashboardListHandler(),
        ...shared,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(document.body)
    const trigger = await canvas.findByRole("button", { name: "New report" })
    await expect(page.queryByRole("dialog")).not.toBeInTheDocument()
    await userEvent.click(trigger)
    const dialog = within(
      await page.findByRole("dialog", { name: "Create report" })
    )
    await expect(
      dialog.getByRole("radio", { name: "Evaluation comparison" })
    ).toBeChecked()
    await expect(
      dialog.queryByRole("textbox", { name: "Report name" })
    ).not.toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
    await waitFor(() =>
      expect(page.queryByRole("dialog")).not.toBeInTheDocument()
    )
    await expect(trigger).toHaveFocus()
    await userEvent.click(trigger)
    const reopened = within(
      await page.findByRole("dialog", { name: "Create report" })
    )
    await userEvent.click(
      reopened.getByRole("radio", { name: "Cost and usage" })
    )
    await userEvent.click(
      reopened.getByRole("button", { name: "Create report" })
    )
    await waitFor(() =>
      expect(getRouter().push).toHaveBeenCalledWith(
        `${storybookProject.prefix}/reports/new?template=cost-and-usage`
      )
    )
  },
}
export const DashboardPicker: Story = {
  ...TemplatePicker,
  play: async ({ canvasElement }) => {
    const page = within(document.body)
    await userEvent.click(
      await within(canvasElement).findByRole("button", { name: "New report" })
    )
    const dialog = within(
      await page.findByRole("dialog", { name: "Create report" })
    )
    const picker = dialog.getByRole("combobox", { name: "Use dashboard" })
    await waitFor(() => expect(picker).toBeEnabled())
    await userEvent.click(picker)
    await userEvent.click(
      await page.findByRole("option", { name: storybookDashboard.name })
    )
    await expect(
      dialog.getByRole("radio", { name: "Evaluation comparison" })
    ).not.toBeChecked()
    await userEvent.click(dialog.getByRole("button", { name: "Create report" }))
    await waitFor(() =>
      expect(getRouter().push).toHaveBeenCalledWith(
        `${storybookProject.prefix}/reports/new?dashboard=${storybookDashboard.id}`
      )
    )
  },
}
export const DirectEntry: Story = {
  render: () => (
    <StorybookProjectFrame title="New report">
      <NewReportPage />
    </StorybookProjectFrame>
  ),
  parameters: {
    nextjs: {
      navigation: {
        pathname: editorNavigation.pathname,
        query: { filter: "startedAt >= -7d" },
      },
    },
    msw: { handlers: [dashboardListHandler()] },
  },
  play: async () => {
    const dialog = within(
      await within(document.body).findByRole("dialog", {
        name: "Create report",
      })
    )
    await userEvent.click(dialog.getByRole("button", { name: "Create report" }))
    await waitFor(() =>
      expect(getRouter().replace).toHaveBeenCalledWith(
        `${storybookProject.prefix}/reports/new?template=evaluation-comparison&filter=startedAt+%3E%3D+-7d`
      )
    )
  },
}
export const PickerError: Story = {
  ...DirectEntry,
  parameters: {
    nextjs: { navigation: { pathname: editorNavigation.pathname, query: {} } },
    msw: { handlers: [dashboardListHandler("error")] },
  },
  play: async () => {
    const dialog = within(
      await within(document.body).findByRole("dialog", {
        name: "Create report",
      })
    )
    await expect(dialog.findByRole("alert")).resolves.toHaveTextContent(
      "Dashboards are unavailable."
    )
    await expect(
      dialog.getByRole("button", { name: "Create report" })
    ).toBeEnabled()
    await userEvent.click(
      dialog.getByRole("button", { name: "Retry dashboards" })
    )
    await expect(getRouter().replace).not.toHaveBeenCalled()
    await userEvent.click(dialog.getByRole("button", { name: "Cancel" }))
    await waitFor(() =>
      expect(getRouter().replace).toHaveBeenCalledWith(
        `${storybookProject.prefix}/reports`
      )
    )
  },
}
export const Generate: Story = {
  render: () => (
    <StorybookProjectFrame title="New report">
      <NewReportPage />
    </StorybookProjectFrame>
  ),
  parameters: {
    nextjs: { navigation: editorNavigation },
    msw: {
      handlers: [
        ...editorHandlers,
        http.post("/api/reports", async ({ request }) => {
          const input = reportInputSchema.parse(await request.json())
          expect(input.mdx).toContain("<Matrix")
          expect(Object.keys(input.sources).length).toBeGreaterThan(0)
          return envelope(report)
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("textbox", { name: "Report MDX source" })
    ).resolves.toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Save draft" }))
    await waitFor(() =>
      expect(getRouter().push).toHaveBeenCalledWith(
        `${storybookProject.prefix}/reports/12`
      )
    )
  },
}
export const GenerationError: Story = {
  ...Generate,
  parameters: {
    nextjs: { navigation: editorNavigation },
    msw: {
      handlers: [
        ...editorHandlers,
        http.post("/api/reports", () =>
          apiError("Narrow the filters before generating.")
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Save draft" })
    )
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Narrow the filters before generating."
    )
    await expect(
      canvas.getByRole("textbox", { name: "Report MDX source" })
    ).toBeVisible()
  },
}

export const DashboardSource: Story = {
  ...Generate,
  parameters: {
    nextjs: {
      navigation: {
        pathname: editorNavigation.pathname,
        query: { dashboard: storybookDashboard.id },
      },
    },
    msw: {
      handlers: [
        dashboardDetailHandler(),
        ...editorHandlers,
        http.post("/api/reports", async ({ request }) => {
          const input = reportInputSchema.parse(await request.json())
          expect(input.name).toBe(storybookDashboard.name)
          expect(Object.keys(input.sources).length).toBe(
            storybookDashboard.widgets.filter((w) => w.type !== "text").length
          )
          return envelope(report)
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("textbox", { name: "Report MDX source" })
    ).resolves.toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Save draft" }))
    await waitFor(() =>
      expect(getRouter().push).toHaveBeenCalledWith(
        `${storybookProject.prefix}/reports/12`
      )
    )
  },
}
export const DashboardSourceLoading: Story = {
  ...Generate,
  parameters: {
    nextjs: {
      navigation: {
        pathname: editorNavigation.pathname,
        query: { dashboard: storybookDashboard.id },
      },
    },
    msw: { handlers: [dashboardDetailHandler("loading")] },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByLabelText("Loading dashboard")
    ).resolves.toBeVisible()
  },
}
export const DashboardSourceError: Story = {
  ...DashboardSourceLoading,
  parameters: {
    nextjs: {
      navigation: {
        pathname: editorNavigation.pathname,
        query: { dashboard: storybookDashboard.id },
      },
    },
    msw: { handlers: [dashboardDetailHandler("error")] },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("alert")
    ).resolves.toHaveTextContent("Dashboard could not be loaded.")
  },
}

function TextReflowScenario() {
  const [expanded, setExpanded] = useState(false)
  return (
    <StorybookProjectFrame title="Text reflow">
      <Button onClick={() => setExpanded(!expanded)}>Toggle long text</Button>
      <DashboardRenderer
        widgets={[
          {
            id: "auto-text",
            type: "text",
            title: "Notes",
            width: 3,
            content: expanded
              ? Array.from(
                  { length: 15 },
                  (_, index) =>
                    `Paragraph ${index + 1}: Findings and recommendations for this evaluation.`
                ).join("\n\n")
              : "Short note.",
          },
          {
            id: "below-text",
            type: "text",
            title: "Next section",
            width: 3,
            content: "This section follows the notes.",
          },
        ]}
      />
    </StorybookProjectFrame>
  )
}
export const TextReflow: Story = {
  render: () => <TextReflowScenario />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("Short note.")).resolves.toBeVisible()
    const first = canvas
      .getByText("Short note.", { exact: true })
      .closest(".react-grid-item")!
    const second = canvas
      .getByText("This section follows the notes.", { exact: true })
      .closest(".react-grid-item")!
    const before = first.getBoundingClientRect().height
    await userEvent.click(
      canvas.getByRole("button", { name: "Toggle long text" })
    )
    await waitFor(() => {
      expect(first.getBoundingClientRect().height).toBeGreaterThan(before + 100)
      expect(second.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        first.getBoundingClientRect().bottom
      )
    })
    await userEvent.click(
      canvas.getByRole("button", { name: "Toggle long text" })
    )
    await waitFor(() =>
      expect(first.getBoundingClientRect().height).toBe(before)
    )
  },
}

function InlineTextScenario() {
  const [widgets, setWidgets] = useState(config.widgets.slice(0, 1))
  const [editing, setEditing] = useState(true)
  return (
    <StorybookProjectFrame title="Inline text">
      <Button onClick={() => setEditing(!editing)}>
        {editing ? "Finish editing" : "Edit text"}
      </Button>
      <DashboardRenderer
        widgets={widgets}
        editable={editing}
        onWidgetChange={(widget) => setWidgets([widget])}
      />
    </StorybookProjectFrame>
  )
}
export const InlineText: Story = {
  render: () => <InlineTextScenario />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const editor = await canvas.findByRole("textbox", {
      name: "Findings content",
    })
    await expect(
      canvas.queryByRole("button", { name: "Edit Findings" })
    ).not.toBeInTheDocument()
    const page = within(document.body)
    const card = editor.closest(".react-grid-item")!
    const transparentColor = getComputedStyle(
      editor.parentElement!
    ).backgroundColor
    await expect(
      canvas.queryByText("Findings", { exact: true })
    ).not.toBeInTheDocument()
    await expect(
      page.queryByRole("group", { name: "Findings content formatting" })
    ).not.toBeInTheDocument()
    await userEvent.unhover(card)
    await expect(card).toHaveClass("bg-transparent")
    await userEvent.click(editor)
    await expect(getComputedStyle(editor).borderTopWidth).toBe("0px")
    await expect(getComputedStyle(editor).outlineStyle).toBe("none")
    await userEvent.clear(editor)
    await userEvent.type(editor, "Inline findings")
    await expect(
      page.queryByRole("group", { name: "Findings content formatting" })
    ).not.toBeInTheDocument()
    const selection = window.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(editor)
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event("selectionchange"))
    await userEvent.click(await page.findByRole("button", { name: "Bold" }))
    await expect(editor.querySelector("strong")).toHaveTextContent(
      "Inline findings"
    )
    canvas.getByRole("button", { name: "Finish editing" }).focus()
    await waitFor(() =>
      expect(
        page.queryByRole("group", { name: "Findings content formatting" })
      ).not.toBeInTheDocument()
    )
    await userEvent.click(editor)
    await userEvent.keyboard("{ArrowRight}")
    await waitFor(() =>
      expect(
        page.queryByRole("group", { name: "Findings content formatting" })
      ).not.toBeInTheDocument()
    )
    await userEvent.unhover(card)
    await waitFor(() =>
      expect(getComputedStyle(card).backgroundColor).toBe(transparentColor)
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Finish editing" })
    )
    await expect(
      canvas.queryByRole("textbox", { name: "Findings content" })
    ).not.toBeInTheDocument()
    await expect(
      canvas.getByText("Inline findings", { exact: true }).tagName
    ).toBe("STRONG")
    await userEvent.click(canvas.getByRole("button", { name: "Edit text" }))
    await expect(
      canvas.findByRole("textbox", { name: "Findings content" })
    ).resolves.toHaveTextContent("Inline findings")
  },
}
export const NarrowFrozenMatrix: Story = {
  ...FrozenMatrix,
  render: () => (
    <div className="w-[390px] max-w-full">
      <StorybookProjectFrame title="Report">
        <ReportDetailPage reportNumber="12" />
      </StorybookProjectFrame>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByRole("table")).resolves.toBeVisible()
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(
      canvasElement.clientWidth
    )
    const card = canvas.getByRole("table").closest(".react-grid-item")!
    await expect(card.getBoundingClientRect().width).toBeLessThanOrEqual(390)
  },
}
