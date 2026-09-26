import { useState, type ComponentProps } from "react"
import { delay, http, HttpResponse } from "msw"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  StorybookProjectFrame,
  storybookProject,
} from "../../.storybook/component-frame"
import {
  dashboardWidgets,
  barWidget,
  lineWidget,
  metricWidget,
  semanticResultForQuery,
} from "../../.storybook/scenarios/dashboards/fixtures"
import {
  envelope,
  metricsBatchHandler,
} from "../../.storybook/scenarios/dashboards/handlers"
import { DashboardRenderer } from "./dashboard-renderer"
import { dashboardFilterScope } from "@/src/lib/tracer/dashboard-queries"
import { Button } from "@/components/ui/button"

function RendererScenario(props: ComponentProps<typeof DashboardRenderer>) {
  return (
    <StorybookProjectFrame title="Dashboard preview">
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <DashboardRenderer {...props} />
      </div>
    </StorybookProjectFrame>
  )
}

const meta = {
  title: "Tracer/Dashboards/DashboardRenderer",
  component: DashboardRenderer,
  args: { widgets: dashboardWidgets },
  parameters: {
    layout: "fullscreen",
    nextjs: {
      navigation: { pathname: `${storybookProject.prefix}/dashboards` },
    },
  },
  render: (args) => <RendererScenario {...args} />,
} satisfies Meta<typeof DashboardRenderer>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {
  parameters: { msw: { handlers: [metricsBatchHandler()] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("Trace volume", { exact: true })
    ).resolves.toBeVisible()
    await expect(
      canvas.findByText("Operations", { exact: true })
    ).resolves.toBeVisible()
    await expect(canvas.findByText("P95 latency")).resolves.toBeVisible()
  },
}

export const Empty: Story = {
  args: { widgets: [dashboardWidgets[1]!] },
  parameters: { msw: { handlers: [metricsBatchHandler("empty")] } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("No data in this time range.")
    ).resolves.toBeVisible()
  },
}

export const Loading: Story = {
  parameters: { msw: { handlers: [metricsBatchHandler("loading")] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByLabelText("Dashboard widgets")
    ).resolves.toBeVisible()
    await expect(
      canvas.queryByText("Loading dashboard…")
    ).not.toBeInTheDocument()
    await waitFor(() =>
      expect(
        canvasElement.querySelectorAll(
          '[data-slot="dashboard-widget-skeleton"]'
        )
      ).toHaveLength(dashboardWidgets.length)
    )
  },
}

export const StableLoadingLayout: Story = {
  args: { widgets: [metricWidget, lineWidget] },
  parameters: {
    msw: {
      handlers: [
        http.post("/api/metrics/batch", async ({ request }) => {
          const { queries } = (await request.json()) as {
            queries: (typeof metricWidget.query)[]
          }
          await delay(1200)
          return envelope(queries.map((query) => semanticResultForQuery(query)))
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(
        canvasElement.querySelectorAll(
          '[data-slot="dashboard-widget-skeleton"]'
        )
      ).toHaveLength(2)
    )
    const cards = Array.from(
      canvasElement.querySelectorAll<HTMLElement>("[data-widget-id]")
    )
    const bounds = cards.map((card) => card.getBoundingClientRect().toJSON())
    for (const card of cards)
      await expect(getComputedStyle(card).transitionDuration).toBe("0s")
    await waitFor(
      () =>
        expect(
          canvasElement.querySelector('[data-slot="dashboard-widget-skeleton"]')
        ).toBeNull(),
      { timeout: 5000 }
    )
    await expect(
      cards.map((card) => card.getBoundingClientRect().toJSON())
    ).toEqual(bounds)
  },
}

export const ErrorAndRetry: Story = {
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
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Metric batch is unavailable."
    )
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }))
    await expect(
      canvas.findByText("Trace volume", { exact: true })
    ).resolves.toBeVisible()
  },
}

const busyMetricHandler = () =>
  http.post(
    "/api/metrics/batch",
    () =>
      HttpResponse.json(
        { error: { code: "READ_BUSY", message: "The read lane is busy." } },
        { status: 429, headers: { "Retry-After": "1" } }
      ),
    { once: true }
  )
const metricValueHandler = (value: number, once = false) =>
  http.post(
    "/api/metrics/batch",
    async ({ request }) => {
      const { queries } = (await request.json()) as { queries: unknown[] }
      return envelope(
        queries.map((query) => {
          const result = semanticResultForQuery(query)
          result.data = [{ [result.query.measures[0]]: value }]
          return result
        })
      )
    },
    { once }
  )

export const BusyInitialLoadRecovers: Story = {
  args: { widgets: [metricWidget] },
  parameters: {
    msw: { handlers: [busyMetricHandler(), metricValueHandler(42)] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvasElement.querySelector('[data-slot="dashboard-widget-skeleton"]')
      ).not.toBeNull()
    )
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
    await expect(
      canvas.findByText("42", { exact: true }, { timeout: 5000 })
    ).resolves.toBeVisible()
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  },
}

function RefreshDuringBusyScenario({
  changeFilter = false,
  ...props
}: ComponentProps<typeof DashboardRenderer> & { changeFilter?: boolean }) {
  const [revision, setRevision] = useState(0)
  return (
    <StorybookProjectFrame title="Dashboard preview">
      <Button onClick={() => setRevision((v) => v + 1)}>Refresh metrics</Button>
      <DashboardRenderer
        {...props}
        revision={revision}
        scope={dashboardFilterScope(
          changeFilter && revision
            ? 'startedAt >= -7d name = "Changed"'
            : "startedAt >= -7d",
          Date.parse("2026-09-16T00:00:00Z") + revision * 30000,
          "UTC"
        )}
      />
    </StorybookProjectFrame>
  )
}

export const BusyRefreshKeepsCharts: Story = {
  args: { widgets: [metricWidget] },
  render: (args) => <RefreshDuringBusyScenario {...args} />,
  parameters: {
    msw: {
      handlers: [
        metricValueHandler(42, true),
        busyMetricHandler(),
        metricValueHandler(84),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("42", { exact: true })
    ).resolves.toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: "Refresh metrics" })
    )
    await expect(canvas.getByText("42", { exact: true })).toBeVisible()
    await expect(
      canvasElement.querySelector('[data-slot="dashboard-widget-skeleton"]')
    ).toBeNull()
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
    await expect(
      canvas.findByText("84", { exact: true }, { timeout: 5000 })
    ).resolves.toBeVisible()
    await expect(
      canvas.queryByText("42", { exact: true })
    ).not.toBeInTheDocument()
  },
}

export const ChangedFilterHidesPreviousResult: Story = {
  args: { widgets: [metricWidget] },
  parameters: {
    msw: {
      handlers: [
        metricValueHandler(42, true),
        busyMetricHandler(),
        metricValueHandler(84),
      ],
    },
  },
  render: (args) => <RefreshDuringBusyScenario {...args} changeFilter />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("42", { exact: true })
    ).resolves.toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: "Refresh metrics" })
    )
    await waitFor(() =>
      expect(canvas.queryByText("42", { exact: true })).not.toBeInTheDocument()
    )
    await expect(
      canvasElement.querySelector('[data-slot="dashboard-widget-skeleton"]')
    ).not.toBeNull()
    await expect(
      canvas.findByText("84", { exact: true }, { timeout: 5000 })
    ).resolves.toBeVisible()
  },
}

export const TablePagination: Story = {
  args: { widgets: [dashboardWidgets[2]!] },
  parameters: { msw: { handlers: [metricsBatchHandler()] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("1–2 of 4")).resolves.toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Next" }))
    await expect(canvas.findByText("3–4 of 4")).resolves.toBeVisible()
    await expect(canvas.getByRole("button", { name: "Previous" })).toBeEnabled()
  },
}

export const VersionComparison: Story = {
  args: {
    widgets: [
      {
        ...lineWidget,
        groups: [{ type: "agent", name: "Research", versions: ["v1", "v2"] }],
        compare: { type: "agent", name: "Research" },
      },
    ],
  },
  parameters: { msw: { handlers: [metricsBatchHandler()] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("Research · v1 · P95 latency")
    ).resolves.toBeVisible()
    await expect(
      canvas.findByText("Research · v2 · P95 latency")
    ).resolves.toBeVisible()
  },
}

export const MetricPreviousPeriod: Story = {
  args: {
    widgets: [
      {
        ...metricWidget,
        title: "Failures",
        query: { ...metricWidget.query, measures: ["traces.erroredCount"] },
      },
    ],
  },
  parameters: {
    msw: {
      handlers: [
        http.post("/api/metrics/batch", async ({ request }) => {
          const { queries } = (await request.json()) as { queries: unknown[] }
          return envelope(
            queries.map((query) => {
              const result = semanticResultForQuery(query)
              const current =
                Date.parse(result.query.timeDimensions[0].dateRange[0]) ===
                Date.parse(metricWidget.query.timeDimensions[0].dateRange[0])
              result.data = result.query.timeDimensions[0].granularity
                ? result.data.map((row, index) => ({
                    ...row,
                    "traces.erroredCount": (index + 1) * 2,
                  }))
                : [{ "traces.erroredCount": current ? 12 : 24 }]
              return result
            })
          )
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("12")).resolves.toBeVisible()
    await expect(
      canvas.findByRole("group", { name: "Failures daily values" })
    ).resolves.toBeVisible()
    await expect(canvas.queryByText("Previous: 24")).not.toBeInTheDocument()
    await expect(canvas.getByText("−50%", { exact: false })).toHaveClass(
      "text-success-foreground"
    )
    await expect(canvasElement.querySelector("[data-widget-id]")).toHaveStyle({
      borderTopWidth: "0px",
    })
    await userEvent.hover(canvas.getByRole("button", { name: /−50%/ }))
    await expect(
      within(canvasElement.ownerDocument.body).findByRole("tooltip")
    ).resolves.toHaveTextContent("Previous: 24")
  },
}

export const NamedScorePreviousPeriod: Story = {
  args: {
    widgets: [
      {
        ...metricWidget,
        title: "Brand extraction: accuracy",
        trendDirection: "increase",
        query: {
          ...metricWidget.query,
          measures: ["scoreValues.meanValue"],
          filters: [
            {
              member: "scoreValues.definitionId",
              operator: "equals",
              values: ["evaluator:brand-v3:score"],
            },
          ],
          timeDimensions: [
            {
              dimension: "scoreValues.recordedAt",
              dateRange: ["2026-09-17T00:00:00Z", "2026-09-24T00:00:00Z"],
            },
          ],
        },
      },
    ],
  },
  parameters: {
    msw: {
      handlers: [
        http.post("/api/metrics/batch", async ({ request }) => {
          const { queries } = (await request.json()) as { queries: unknown[] }
          return envelope(
            queries.map((query) => {
              const result = semanticResultForQuery(query)
              const current =
                Date.parse(result.query.timeDimensions[0].dateRange[0]) ===
                Date.parse("2026-09-17T00:00:00Z")
              result.data = result.query.timeDimensions[0].granularity
                ? [0.8, 0.9, 1].map((value, index) => ({
                    "scoreValues.meanValue": value,
                    "scoreValues.recordedAt": `2026-09-${17 + index}`,
                  }))
                : [{ "scoreValues.meanValue": current ? 0.9 : 0.5 }]
              return result
            })
          )
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("0.9", { exact: true })
    ).resolves.toBeVisible()
    await expect(
      canvas.findByText("+80%", { exact: true })
    ).resolves.toBeVisible()
    await userEvent.hover(canvas.getByRole("button", { name: /\+80%/ }))
    const tooltip = await within(canvasElement.ownerDocument.body).findByRole(
      "tooltip"
    )
    await expect(tooltip).toHaveTextContent("Previous: 0.5")
    await expect(tooltip).toHaveTextContent("Sep 10, 2026")
    await expect(tooltip).toHaveTextContent("Sep 17, 2026")
  },
}

const costWidget = {
  ...barWidget,
  title: "Cost by LLM call",
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
}
const costHandler = http.post("/api/metrics/batch", async ({ request }) => {
  const { queries } = (await request.json()) as { queries: unknown[] }
  return envelope(
    queries.map((query) => {
      const result = semanticResultForQuery(query, { total: 1 })
      result.data = [
        {
          "logs.functionName": "extract-mentioned-brands",
          "logs.costUsd": 2.6585,
        },
      ]
      return result
    })
  )
})
export const CostPresentation: Story = {
  args: { widgets: [costWidget] },
  parameters: { msw: { handlers: [costHandler] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("extract-mentioned-brands", { exact: true })
    ).resolves.toBeVisible()
    await expect(
      canvas.queryByRole("combobox", { name: "Break down costs by" })
    ).not.toBeInTheDocument()
    await expect(
      canvas.queryByRole("button", { name: /Break down/ })
    ).not.toBeInTheDocument()
    await expect(canvas.queryByText(/Known costs only/)).not.toBeInTheDocument()
    await expect(
      canvas.queryByRole("img", { name: "llm" })
    ).not.toBeInTheDocument()
  },
}
export const OptionalGroupIcons: Story = {
  ...CostPresentation,
  args: { widgets: [{ ...costWidget, showGroupIcons: true }] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("img", { name: "llm" })
    ).resolves.toBeVisible()
    await expect(
      canvas.queryByRole("combobox", { name: "Break down costs by" })
    ).not.toBeInTheDocument()
  },
}
export const OptionalDonutGroupIcons: Story = {
  ...OptionalGroupIcons,
  args: { widgets: [{ ...costWidget, type: "donut", showGroupIcons: true }] },
}
export const CostTablePresentation: Story = {
  ...CostPresentation,
  args: { widgets: [{ ...costWidget, type: "table" }] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("extract-mentioned-brands", { exact: true })
    ).resolves.toBeVisible()
    await expect(canvas.getAllByRole("columnheader")).toHaveLength(2)
    await expect(
      canvas.queryByRole("img", { name: "llm" })
    ).not.toBeInTheDocument()
  },
}
export const OptionalTableGroupIcons: Story = {
  ...OptionalGroupIcons,
  args: { widgets: [{ ...costWidget, type: "table", showGroupIcons: true }] },
}

export const TableUsesAvailableHeight: Story = {
  args: {
    widgets: [
      {
        ...costWidget,
        type: "table",
        layout: { x: 0, y: 0, w: 6, h: 10 },
      },
    ],
  },
  parameters: {
    msw: {
      handlers: [
        http.post("/api/metrics/batch", async ({ request }) => {
          const { queries } = (await request.json()) as { queries: unknown[] }
          return envelope(
            queries.map((query) => {
              const result = semanticResultForQuery(query, { total: 8 })
              result.data = Array.from({ length: 8 }, (_, index) => ({
                "logs.functionName": `LLM call ${index + 1}`,
                "logs.costUsd": index + 1,
              }))
              return result
            })
          )
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const lastCell = await within(canvasElement).findByText("LLM call 8")
    const widget = lastCell.closest("[data-widget-id]")!
    const lastRow = lastCell.closest("tr")!.getBoundingClientRect()
    // Every row fits in this tall widget; no nested viewport may clip it early.
    for (
      let parent = lastCell.parentElement;
      parent && parent !== widget;
      parent = parent.parentElement
    ) {
      if (
        /(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)
      ) {
        await expect(lastRow.bottom).toBeLessThanOrEqual(
          parent.getBoundingClientRect().bottom + 1
        )
      }
    }
    await expect(lastRow.bottom).toBeLessThanOrEqual(
      widget.getBoundingClientRect().bottom
    )
  },
}

export const StaleWhileRevalidate: Story = {
  args: {
    widgets: [metricWidget],
    scope: dashboardFilterScope(
      "startedAt >= -7d",
      Date.parse("2026-09-16T00:00:00Z"),
      "UTC"
    ),
  },
  parameters: {
    msw: {
      handlers: [
        http.post(
          "/api/metrics/batch",
          async ({ request }) => {
            const { queries } = (await request.json()) as { queries: unknown[] }
            const response = envelope(
              queries.map((query) => {
                const result = semanticResultForQuery(query)
                result.data = [{ [result.query.measures[0]]: 42 }]
                return result
              })
            )
            response.headers.set("X-Datool-Cache", "stale")
            return response
          },
          { once: true }
        ),
        http.post("/api/metrics/batch", async ({ request }) => {
          const { queries } = (await request.json()) as { queries: unknown[] }
          const response = envelope(
            queries.map((query) => {
              const result = semanticResultForQuery(query)
              result.data = [{ [result.query.measures[0]]: 84 }]
              return result
            })
          )
          response.headers.set("X-Datool-Cache", "fresh")
          return response
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("42", { exact: true })
    ).resolves.toBeVisible()
    await expect(
      canvas.queryByText("Loading widget data…")
    ).not.toBeInTheDocument()
    await expect(
      canvas.findByText("84", { exact: true }, { timeout: 10000 })
    ).resolves.toBeVisible()
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  },
}
