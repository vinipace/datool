import { http } from "msw"
import {
  metricsBatchHandler,
  metricsQueryHandler,
  envelope,
} from "../../.storybook/scenarios/dashboards/handlers"
import { semanticResultForQuery } from "../../.storybook/scenarios/dashboards/fixtures"
import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import type { SemanticCatalogMetadata } from "@/src/lib/semantic/catalog"
import {
  dashboardWidgetSchema,
  type DashboardWidget,
} from "@/src/lib/tracer/dashboards"
import {
  StorybookProjectFrame,
  storybookProject,
} from "../../.storybook/component-frame"
import {
  dashboardCatalog,
  barWidget,
  lineWidget,
  metricWidget,
  tableWidget,
} from "../../.storybook/scenarios/dashboards/fixtures"
import type { RemoteState } from "./hooks"
import { DashboardWidgetEditor } from "./dashboard-widget-editor"
import { DashboardCatalogContext } from "./dashboard-catalog-context"

type CatalogScenario = "ready" | "loading" | "error"

function EditorScenario({
  initialWidget,
  catalogScenario = "ready",
}: {
  initialWidget: DashboardWidget
  catalogScenario?: CatalogScenario
}) {
  const [widget, setWidget] = useState(() =>
    dashboardWidgetSchema.parse(initialWidget)
  )
  const [catalogMode, setCatalogMode] = useState(catalogScenario)
  const catalog: RemoteState<SemanticCatalogMetadata> = {
    data: catalogMode === "ready" ? dashboardCatalog : null,
    error:
      catalogMode === "error" ? new Error("Metrics are unavailable.") : null,
    isLoading: catalogMode === "loading",
    isRefreshing: false,
    refresh: () => setCatalogMode("ready"),
  }

  return (
    <StorybookProjectFrame title="Widget editor">
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <DashboardCatalogContext value={catalog}>
          <DashboardWidgetEditor
            widget={widget}
            editable
            onPropsChange={(patch) => {
              if (patch.widget) setWidget(patch.widget)
            }}
          />
        </DashboardCatalogContext>
        <pre aria-label="Saved widget" className="sr-only">
          {JSON.stringify(widget)}
        </pre>
      </div>
    </StorybookProjectFrame>
  )
}

const meta = {
  title: "Tracer/Dashboards/DashboardWidgetEditor",
  component: EditorScenario,
  args: { initialWidget: metricWidget },
  parameters: {
    layout: "fullscreen",
    msw: { handlers: [metricsBatchHandler(), metricsQueryHandler()] },
    nextjs: {
      navigation: { pathname: `${storybookProject.prefix}/dashboards/editor` },
    },
  },
} satisfies Meta<typeof EditorScenario>

export default meta
type Story = StoryObj<typeof meta>

export const EditingControls: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const title = await canvas.findByLabelText("Title")
    await userEvent.clear(title)
    await userEvent.type(title, "Captured traces")
    await expect(title).toHaveValue("Captured traces")

    await userEvent.click(
      canvas.getByRole("combobox", { name: "Visualization" })
    )
    await userEvent.click(
      await within(canvasElement.ownerDocument.body).findByRole("option", {
        name: "Bar chart",
      })
    )
    await expect(
      canvas.getByRole("combobox", { name: "Group by" })
    ).toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "Remove Operation" })
    ).toHaveAttribute("aria-disabled", "true")
  },
}

export const DataSourceSelection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    const source = canvas.getByRole("combobox", { name: "Data source" })
    await expect(source).toHaveTextContent("Traces")
    await userEvent.click(source)
    await userEvent.type(
      await body.findByLabelText("Search data source"),
      "spans"
    )
    await userEvent.click(
      await body.findByRole("option", { name: /Spans Individual steps/ })
    )
    await expect(source).toHaveTextContent("Spans")
    const saved = JSON.parse(canvas.getByLabelText("Saved widget").textContent!)
    await expect(saved.query.measures).toEqual(["spans.spanCount"])
    await expect(dashboardWidgetSchema.safeParse(saved).success).toBe(true)
    await userEvent.click(source)
    await userEvent.keyboard("{Escape}")
    await expect(source).toHaveFocus()
  },
}

export const SwitchBarToDonut: Story = {
  args: { initialWidget: barWidget },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("combobox", { name: "Visualization" })
    )
    await userEvent.click(
      await within(canvasElement.ownerDocument.body).findByRole("option", {
        name: "Donut chart",
      })
    )
    const saved = JSON.parse(canvas.getByLabelText("Saved widget").textContent!)
    await expect(saved.type).toBe("donut")
    await expect(saved.query).toEqual(barWidget.query)
    await expect(dashboardWidgetSchema.safeParse(saved).success).toBe(true)
    await expect(
      canvas.getByRole("combobox", { name: "Measure" })
    ).toBeVisible()
  },
}

export const CostByModel: Story = {
  args: {
    initialWidget: {
      ...lineWidget,
      title: "Cost by model over time",
      query: { ...lineWidget.query, measures: ["logs.costUsd"] },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole("combobox", { name: "Series by" }))
    await userEvent.click(
      await body.findByRole("option", { name: "LLM model" })
    )
    const saved = () =>
      JSON.parse(canvas.getByLabelText("Saved widget").textContent!)
    await expect(saved().query.dimensions).toEqual(["logs.model"])
    await expect(saved().query.timeDimensions[0].granularity).toBe("day")
    await expect(dashboardWidgetSchema.safeParse(saved()).success).toBe(true)
    await userEvent.click(
      canvas.getByRole("combobox", { name: "Visualization" })
    )
    await userEvent.click(
      await body.findByRole("option", { name: "Stacked time chart" })
    )
    await expect(saved().query.dimensions).toEqual(["logs.model"])
    await userEvent.click(canvas.getByRole("combobox", { name: "Series by" }))
    await userEvent.click(
      await body.findByRole("option", { name: "Measure only" })
    )
    await expect(saved().query.dimensions).toEqual([])
  },
}

export const AgentWorkflowAndVersionFilters: Story = {
  args: { initialWidget: lineWidget },
  parameters: {
    msw: {
      handlers: [
        http.post("/api/metrics/batch", async ({ request }) => {
          const { queries } = (await request.json()) as { queries: unknown[] }
          return envelope(
            queries.map((query, index) => {
              const result = semanticResultForQuery(query)
              const model = index === 0 ? "agents" : "workflows"
              result.data = (
                index === 0
                  ? [
                      ["Research", "v1"],
                      ["Research", "v2"],
                      ["Support", null],
                    ]
                  : [["Briefing", "main"]]
              ).map(([name, version]) => ({
                [`${model}.name`]: name,
                [`${model}.version`]: version,
                [`${model}.count`]: 10,
              }))
              result.meta.page.total = result.data.length
              return result
            })
          )
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await expect(canvas.queryByText("Advanced query")).not.toBeInTheDocument()
    const choose = async (label: string, text: string) => {
      const input = await canvas.findByRole("combobox", {
        name: label,
      })
      await waitFor(() => expect(input).toBeEnabled())
      await userEvent.click(input)
      await userEvent.type(input, text)
      await userEvent.click(await body.findByRole("option", { name: text }))
      await userEvent.keyboard("{Escape}")
    }
    for (const name of ["Agents", "Workflows"]) {
      await userEvent.click(
        canvas.getByRole("combobox", { name: "Add filter" })
      )
      await userEvent.click(await body.findByRole("option", { name }))
    }
    await choose("Agents", "Research")
    await choose("Agents", "Support")
    await choose("Workflows", "Briefing")
    await expect(
      JSON.parse(canvas.getByLabelText("Saved widget").textContent!).groups
    ).toHaveLength(3)
    await choose("Versions", "Research · v1")
    await choose("Versions", "Research · v2")
    await userEvent.click(
      canvas.getByRole("combobox", { name: "Compare versions" })
    )
    await userEvent.click(await body.findByRole("option", { name: "Research" }))
    let saved = JSON.parse(canvas.getByLabelText("Saved widget").textContent!)
    await expect(saved.compare).toEqual({ type: "agent", name: "Research" })
    await expect(saved.groups).toContainEqual({
      type: "agent",
      name: "Research",
      versions: ["v1", "v2"],
    })
    await userEvent.click(
      canvas.getByRole("button", { name: "Remove Research · v1" })
    )
    saved = JSON.parse(canvas.getByLabelText("Saved widget").textContent!)
    await expect(saved.compare).toBeUndefined()
    await expect(saved.groups).toContainEqual({
      type: "agent",
      name: "Research",
      versions: ["v2"],
    })
    await userEvent.click(
      canvas.getByRole("button", { name: "Remove Research" })
    )
    await expect(
      canvas.queryByRole("button", { name: "Remove Research · v2" })
    ).not.toBeInTheDocument()
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  },
}

export const FilterErrorAndRetry: Story = {
  args: { initialWidget: lineWidget },
  parameters: {
    msw: {
      handlers: [
        metricsBatchHandler("error", { once: true }),
        metricsBatchHandler(),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("combobox", { name: "Add filter" }))
    await userEvent.click(
      await within(canvasElement.ownerDocument.body).findByRole("option", {
        name: "Agents",
      })
    )
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Unable to load agents and workflows"
    )
    await userEvent.click(canvas.getByRole("button", { name: "Retry filters" }))
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  },
}

export const NoGroupsInWindow: Story = {
  args: {
    initialWidget: {
      ...lineWidget,
      groups: [{ type: "agent", name: "Saved agent", versions: ["v1"] }],
    },
  },
  parameters: { msw: { handlers: [metricsBatchHandler("empty")] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("button", { name: "Remove Saved agent · v1" })
    ).resolves.toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: "Remove Saved agent · v1" })
    )
    await expect(
      canvas.queryByRole("button", { name: "Remove Saved agent · v1" })
    ).not.toBeInTheDocument()
  },
}

export const MultipleMeasures: Story = {
  args: { initialWidget: lineWidget },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    const input = await canvas.findByRole("combobox", { name: "Measures" })
    await expect(
      canvas.queryByText("Additional measures")
    ).not.toBeInTheDocument()
    await userEvent.type(input, "Output cost")
    await userEvent.click(
      await body.findByRole("option", { name: "Output cost" })
    )
    await userEvent.keyboard("{Escape}")
    await userEvent.click(
      canvas.getByRole("button", { name: "Remove P95 latency" })
    )
    const query = JSON.parse(
      canvas.getByLabelText("Saved widget").textContent!
    ).query
    await expect(query.measures).toEqual([
      "logs.meanLatencyMs",
      "logs.outputCostUsd",
    ])
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  },
}

export const CatalogLoading: Story = {
  args: { catalogScenario: "loading" },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("status")
    ).resolves.toHaveTextContent("Loading available metrics")
  },
}

export const CatalogErrorAndRetry: Story = {
  args: { catalogScenario: "error" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Metrics are unavailable."
    )
    await userEvent.click(canvas.getByRole("button", { name: "Retry metrics" }))
    await expect(canvas.findByLabelText("Title")).resolves.toBeVisible()
  },
}

export const MetricAndMetadataFilters: Story = {
  args: { initialWidget: lineWidget },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      body = within(canvasElement.ownerDocument.body)
    const add = async (name: string) => {
      await userEvent.click(
        canvas.getByRole("combobox", { name: "Add filter" })
      )
      await userEvent.click(await body.findByRole("option", { name }))
    }
    await expect(
      canvas.queryByRole("combobox", { name: "Agents" })
    ).not.toBeInTheDocument()
    await add("Metric value")
    await userEvent.click(
      canvas.getByRole("combobox", { name: "Metric value field" })
    )
    await userEvent.click(
      await body.findByRole("option", { name: "Trace durationMs" })
    )
    await userEvent.type(
      canvas.getByRole("spinbutton", { name: "Metric value value" }),
      "2000"
    )
    let saved = JSON.parse(canvas.getByLabelText("Saved widget").textContent!)
    await expect(saved.query.filters).toContainEqual({
      member: "logs.parent.durationMs",
      operator: "gte",
      values: [2000],
    })
    await userEvent.click(
      canvas.getByRole("combobox", { name: "Metric value operator" })
    )
    await userEvent.click(
      await body.findByRole("option", { name: "Less than or equal (lte)" })
    )
    await add("Metadata")
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Metadata key" }),
      "environment"
    )
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Metadata value" }),
      "production"
    )
    saved = JSON.parse(canvas.getByLabelText("Saved widget").textContent!)
    await expect(saved.query.filters).toContainEqual({
      member: "logs.parent.metadata",
      path: ["environment"],
      operator: "equals",
      values: ["production"],
    })
    await expect(saved.query.filters[0].operator).toBe("lte")
    await userEvent.click(
      canvas.getByRole("button", { name: "Remove Metric value filter" })
    )
    saved = JSON.parse(canvas.getByLabelText("Saved widget").textContent!)
    await expect(saved.query.filters).toHaveLength(1)
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  },
}

export const AggregateMeasureFilter: Story = {
  args: {
    initialWidget: {
      ...tableWidget,
      query: {
        ...tableWidget.query,
        measures: ["traces.count", "traces.erroredCount"],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      body = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole("combobox", { name: "Add filter" }))
    await userEvent.click(
      await body.findByRole("option", { name: "Metric value" })
    )
    await userEvent.click(
      canvas.getByRole("combobox", { name: "Metric value field" })
    )
    await userEvent.click(
      await body.findByRole("option", { name: "Errored traces · Aggregate" })
    )
    await userEvent.click(
      canvas.getByRole("combobox", { name: "Metric value operator" })
    )
    await userEvent.click(
      await body.findByRole("option", { name: "Greater than (gt)" })
    )
    await userEvent.type(
      canvas.getByRole("spinbutton", { name: "Metric value value" }),
      "5"
    )
    const saved = () =>
      JSON.parse(canvas.getByLabelText("Saved widget").textContent!)
    await expect(saved().query.having).toEqual([
      { member: "traces.erroredCount", operator: "gt", values: [5] },
    ])
    await expect(saved().query.filters).toEqual([])
    // A threshold can still be used when its measure is not displayed.
    await userEvent.click(
      canvas.getByRole("button", { name: "Remove Errored traces" })
    )
    await expect(saved().query.having).toHaveLength(1)
    await expect(saved().query.measures).toEqual(["traces.count"])
    await userEvent.click(
      canvas.getByRole("button", { name: "Remove Metric value filter" })
    )
    await expect(saved().query.having).toBeUndefined()
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  },
}

export const SavedAggregateMeasureFilter: Story = {
  args: {
    initialWidget: {
      ...tableWidget,
      query: {
        ...tableWidget.query,
        having: [
          { member: "traces.erroredCount", operator: "gt", values: [5] },
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("combobox", { name: "Metric value field" })
    ).toHaveTextContent("Errored traces")
    await expect(
      canvas.getByRole("spinbutton", { name: "Metric value value" })
    ).toHaveValue(5)
    await expect(
      canvas.getByRole("combobox", { name: "Metric value operator" })
    ).toHaveTextContent("Greater than (gt)")
  },
}

export const SelectFailureMetric: Story = {
  args: {
    initialWidget: {
      ...metricWidget,
      title: "Spans",
      query: {
        ...lineWidget.query,
        measures: ["logs.spanCount"],
        timeDimensions: lineWidget.query.timeDimensions.map(
          ({ dimension, dateRange }) => ({ dimension, dateRange })
        ),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole("combobox", { name: "Measure" }))
    await userEvent.type(await body.findByLabelText("Search measure"), "error")
    await userEvent.click(
      await body.findByRole("option", {
        name: "Failed spans",
      })
    )
    await expect(canvas.getByRole("textbox", { name: "Title" })).toHaveValue(
      "Failed spans"
    )
    await expect(
      JSON.parse(canvas.getByLabelText("Saved widget").textContent!).query
        .measures
    ).toEqual(["logs.erroredCount"])
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  },
}

export const RankFailures: Story = {
  args: {
    initialWidget: {
      ...tableWidget,
      query: {
        ...tableWidget.query,
        measures: ["traces.erroredCount"],
        order: [],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole("combobox", { name: "Sort by" }))
    await userEvent.click(
      await body.findByRole("option", { name: "Errored traces" })
    )
    await expect(
      canvas.getByRole("combobox", { name: "Sort direction" })
    ).toHaveTextContent("Highest first")
    await expect(
      JSON.parse(canvas.getByLabelText("Saved widget").textContent!).query.order
    ).toEqual([["traces.erroredCount", "desc"]])
  },
}

export const MetricImprovementDirection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    const direction = await canvas.findByRole("combobox", {
      name: "Improvement direction",
    })
    await expect(direction).toHaveTextContent("Automatic (neutral)")
    await userEvent.click(direction)
    await userEvent.click(
      await body.findByRole("option", { name: "Higher is better" })
    )
    await expect(
      JSON.parse(canvas.getByLabelText("Saved widget").textContent!)
        .trendDirection
    ).toBe("increase")
    await userEvent.click(direction)
    await userEvent.click(
      await body.findByRole("option", { name: "Lower is better" })
    )
    await expect(
      JSON.parse(canvas.getByLabelText("Saved widget").textContent!)
        .trendDirection
    ).toBe("decrease")
    await userEvent.click(direction)
    await userEvent.click(
      await body.findByRole("option", { name: "Automatic (neutral)" })
    )
    await expect(
      JSON.parse(canvas.getByLabelText("Saved widget").textContent!)
        .trendDirection
    ).toBeUndefined()
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  },
}

export const GroupIconsConfiguration: Story = {
  args: {
    initialWidget: {
      ...barWidget,
      query: {
        ...barWidget.query,
        measures: ["logs.costUsd"],
        dimensions: ["logs.functionName"],
        timeDimensions: barWidget.query.timeDimensions.map((time) => ({
          ...time,
          dimension: "logs.startedAt",
        })),
        order: [],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      body = within(canvasElement.ownerDocument.body)
    const saved = () =>
      JSON.parse(canvas.getByLabelText("Saved widget").textContent!)
    const toggle = await canvas.findByRole("switch", {
      name: "Show group icons",
    })
    await expect(toggle).not.toBeChecked()
    await expect(saved().showGroupIcons ?? false).toBe(false)
    await userEvent.click(toggle)
    await expect(saved().showGroupIcons).toBe(true)
    const selected = ["logs.functionName"]
    for (const [label, member] of [
      ["Agent", "logs.agentName"],
      ["Workflow", "logs.workflowName"],
      ["Step", "logs.stepName"],
    ]) {
      await userEvent.click(canvas.getByRole("combobox", { name: "Group by" }))
      await userEvent.click(await body.findByRole("option", { name: label }))
      selected.push(member)
      await userEvent.keyboard("{Escape}")
      await expect(saved().query.dimensions).toEqual(selected)
      await expect(saved().showGroupIcons).toBe(true)
    }
    await userEvent.click(toggle)
    await expect(saved().showGroupIcons).toBe(false)
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  },
}

export const MultipleGroupings: Story = {
  args: { initialWidget: barWidget },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      body = within(canvasElement.ownerDocument.body)
    const saved = () =>
      JSON.parse(canvas.getByLabelText("Saved widget").textContent!)
    const group = canvas.getByRole("combobox", { name: "Group by" })
    await userEvent.type(group, "Trace")
    await userEvent.click(await body.findByRole("option", { name: "Trace" }))
    await userEvent.keyboard("{Escape}")
    await expect(saved().query.dimensions).toEqual([
      "traces.operation",
      "traces.trace",
    ])
    for (const name of ["Donut chart", "Table", "Bar chart"]) {
      await userEvent.click(
        canvas.getByRole("combobox", { name: "Visualization" })
      )
      await userEvent.click(await body.findByRole("option", { name }))
      await expect(saved().query.dimensions).toEqual([
        "traces.operation",
        "traces.trace",
      ])
      await expect(saved().query.filters).toEqual(barWidget.query.filters)
    }
    await userEvent.click(
      canvas.getByRole("button", { name: "Remove Operation" })
    )
    await expect(saved().query.dimensions).toEqual(["traces.trace"])
    await expect(
      canvas.getByRole("button", { name: "Remove Trace" })
    ).toHaveAttribute("aria-disabled", "true")
    await userEvent.type(group, "no-such-field")
    await expect(body.getByText("No options found.")).toBeVisible()
    await userEvent.keyboard("{Escape}")
    await expect(saved().query.dimensions).toEqual(["traces.trace"])
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  },
}

export const TableGroupingsSurviveUnrelatedEdits: Story = {
  args: {
    initialWidget: {
      ...tableWidget,
      query: {
        ...tableWidget.query,
        dimensions: ["traces.operation", "traces.trace"],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("button", { name: "Remove Operation" })
    ).toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "Remove Trace" })
    ).toBeVisible()
    await userEvent.type(canvas.getByLabelText("Title"), " updated")
    await expect(
      JSON.parse(canvas.getByLabelText("Saved widget").textContent!).query
        .dimensions
    ).toEqual(["traces.operation", "traces.trace"])
    await userEvent.click(
      canvas.getByRole("button", { name: "Remove Operation" })
    )
    await userEvent.click(canvas.getByRole("button", { name: "Remove Trace" }))
    await expect(
      JSON.parse(canvas.getByLabelText("Saved widget").textContent!).query
        .dimensions
    ).toEqual([])
  },
}

export const SwitchingVisualizationDropsUnavailableSort: Story = {
  args: {
    initialWidget: {
      ...tableWidget,
      query: {
        ...tableWidget.query,
        measures: ["traces.count", "traces.erroredCount"],
        dimensions: ["traces.operation", "traces.trace"],
        order: [["traces.erroredCount", "desc"]],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      body = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      canvas.getByRole("combobox", { name: "Visualization" })
    )
    await userEvent.click(
      await body.findByRole("option", { name: "Bar chart" })
    )
    const saved = JSON.parse(canvas.getByLabelText("Saved widget").textContent!)
    await expect(saved.query.measures).toEqual(["traces.count"])
    await expect(saved.query.dimensions).toEqual([
      "traces.operation",
      "traces.trace",
    ])
    await expect(saved.query.order).toEqual([])
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  },
}

export const FiveSourcesAndRatingDefinition: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      body = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole("combobox", { name: "Data source" }))
    const options = await body.findAllByRole("option")
    await expect(options).toHaveLength(5)
    await userEvent.click(
      await body.findByRole("option", { name: /Scores Saved ratings/ })
    )
    const definition = await canvas.findByRole("combobox", {
      name: "Score definition",
    })
    await waitFor(() => expect(definition).not.toBeDisabled())
    await userEvent.click(canvas.getByRole("combobox", { name: "Measure" }))
    await expect(
      await body.findByRole("option", { name: /Average numeric value/ })
    ).toHaveAttribute("aria-disabled", "true")
    await userEvent.keyboard("{Escape}")
    await userEvent.click(definition)
    await userEvent.type(
      await body.findByLabelText("Search score definition"),
      "accuracy"
    )
    await userEvent.click(
      await body.findByRole("option", {
        name: /Brand extraction: accuracy Version 3 · numeric · 0–1/,
      })
    )
    await expect(
      canvas.getByRole("combobox", { name: "Measure" })
    ).toHaveTextContent("Average numeric value")
    await expect(definition).toHaveTextContent("Brand extraction: accuracy")
    const saved = JSON.parse(canvas.getByLabelText("Saved widget").textContent!)
    await expect(saved.title).toBe("Brand extraction: accuracy")
    await expect(saved.query.measures).toEqual(["scoreValues.meanValue"])
    await expect(saved.query.filters).toContainEqual({
      member: "scoreValues.definitionId",
      operator: "equals",
      values: ["evaluator:brand-v3:score"],
    })
    await userEvent.click(definition)
    await userEvent.keyboard("{Escape}")
    await expect(definition).toHaveFocus()
  },
}

const scoreMetric = dashboardWidgetSchema.parse({
  ...metricWidget,
  title: "Numeric ratings",
  query: {
    measures: ["scoreValues.count"],
    timeDimensions: [
      {
        dimension: "scoreValues.recordedAt",
        dateRange: ["2026-09-17T00:00:00Z", "2026-09-24T00:00:00Z"],
      },
    ],
  },
})

export const ScoreDefinitionsLoading: Story = {
  args: { initialWidget: scoreMetric },
  parameters: { msw: { handlers: [metricsQueryHandler("loading")] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("Loading definitions…")
    ).resolves.toBeVisible()
    await expect(
      canvas.getByRole("combobox", { name: "Score definition" })
    ).toBeDisabled()
  },
}

export const ScoreDefinitionsEmpty: Story = {
  args: { initialWidget: scoreMetric },
  parameters: { msw: { handlers: [metricsQueryHandler("empty")] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const definition = canvas.getByRole("combobox", {
      name: "Score definition",
    })
    await waitFor(() => expect(definition).not.toBeDisabled())
    await userEvent.click(definition)
    await expect(
      await within(canvasElement.ownerDocument.body).findAllByRole("option")
    ).toHaveLength(1)
    await userEvent.keyboard("{Escape}")
  },
}

export const ScoreDefinitionsRetry: Story = {
  args: { initialWidget: scoreMetric },
  parameters: {
    msw: {
      handlers: [
        metricsQueryHandler("error", { once: true }),
        metricsQueryHandler(),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByRole("alert")).resolves.toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: "Retry definitions" })
    )
    await waitFor(() =>
      expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
    )
    await waitFor(() =>
      expect(
        canvas.getByRole("combobox", { name: "Score definition" })
      ).not.toBeDisabled()
    )
    await userEvent.click(
      canvas.getByRole("combobox", { name: "Score definition" })
    )
    await userEvent.click(
      await within(canvasElement.ownerDocument.body).findByRole("option", {
        name: /Brand extraction: accuracy/,
      })
    )
    await expect(
      canvas.getByRole("combobox", { name: "Measure" })
    ).toHaveTextContent("Average numeric value")
  },
}

export const ClearScoreDefinition: Story = {
  args: { initialWidget: { ...scoreMetric, title: "My accuracy tile" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      body = within(canvasElement.ownerDocument.body)
    const definition = await canvas.findByRole("combobox", {
      name: "Score definition",
    })
    await waitFor(() => expect(definition).not.toBeDisabled())
    await userEvent.click(definition)
    await userEvent.click(
      await body.findByRole("option", { name: /Brand extraction: accuracy/ })
    )
    await expect(canvas.getByLabelText("Title")).toHaveValue("My accuracy tile")
    await userEvent.click(definition)
    await userEvent.click(
      await body.findByRole("option", { name: "All definitions (counts only)" })
    )
    const saved = JSON.parse(canvas.getByLabelText("Saved widget").textContent!)
    await expect(saved.query.measures).toEqual(["scoreValues.count"])
    await expect(saved.query.filters).toEqual([])
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  },
}

export const ExplicitLegacyMigration: Story = {
  args: {
    initialWidget: {
      ...lineWidget,
      query: { ...lineWidget.query, measures: ["logs.costUsd"] },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Preview source migration" })
    )
    await expect(canvas.getByText(/Usage keeps span-start/)).toBeVisible()
    await expect(
      JSON.parse(canvas.getByLabelText("Saved widget").textContent!).query
        .measures
    ).toEqual(["logs.costUsd"])
    await userEvent.click(
      canvas.getByRole("button", { name: "Apply source migration" })
    )
    await expect(
      JSON.parse(canvas.getByLabelText("Saved widget").textContent!).query
        .measures
    ).toEqual(["spans.costUsd"])
  },
}
