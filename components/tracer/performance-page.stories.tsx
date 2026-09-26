import { checkCollectionSelection, checkCollectionPanel, checkCompactCollectionPanel } from "../../.storybook/collection-panel-checks"
import type { ComponentProps } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import { http, HttpResponse } from "msw"
import { semanticQuerySchema } from "@/src/lib/semantic"
import { semanticResultForQuery } from "../../.storybook/scenarios/dashboards/fixtures"
import {
  StorybookProjectFrame,
  storybookProject,
} from "../../.storybook/component-frame"
import {
  customFieldsHandler,
  customViewsHandler,
  metricsQueryHandler,
  performanceHandlers,
} from "../../.storybook/scenarios/dashboards/handlers"
import { PerformancePage } from "./performance-page"

const fixedFilter = 'startedAt >= "2026-09-08" startedAt < "2026-09-11"'

function groupedPerformanceHandler(model: "agents" | "workflows") {
  return http.post("/api/metrics/query", async ({ request }) => {
    const query = semanticQuerySchema.parse(await request.json())
    await expect(query.dimensions).toEqual([`${model}.name`])
    await expect(query.measures).toContain(`${model}.versionCount`)
    return HttpResponse.json({ data: semanticResultForQuery(query) })
  })
}

async function checkVersions(canvasElement: HTMLElement, name: string) {
  const canvas = within(canvasElement)
  await expect(canvas.getByRole("columnheader", { name: "Versions" })).toBeVisible()
  const link = canvas.getByRole("link", { name: new RegExp(name) })
  const row = link.closest("tr")!
  const selectAll = canvas.getByRole("checkbox", { name: /^Select all visible/ })
  const selectRow = within(row).getByRole("checkbox", { name: `Select ${name}` })
  selectRow.focus()
  await expect(selectRow).toBeVisible()
  await expect(selectAll.getBoundingClientRect().left).toBe(selectRow.getBoundingClientRect().left)
  await expect(selectAll.getBoundingClientRect().width).toBe(selectRow.getBoundingClientRect().width)
  await expect(within(row).getByRole("cell", { name: "3" })).toBeVisible()
  const filter = new URL(link.getAttribute("href")!, "http://localhost").searchParams.get("filter")!
  await expect(filter).toContain(`groupName = ${JSON.stringify(name)}`)
  await expect(filter).not.toContain("groupVersion")
  await expect(row).not.toHaveTextContent("2026.09")
  await userEvent.click(canvas.getByRole("button", { name: "Display" }))
  const versions = within(document.body).getByRole("menuitemcheckbox", { name: "Versions" })
  await userEvent.click(versions)
  await expect(canvas.queryByRole("columnheader", { name: "Versions" })).not.toBeInTheDocument()
  await userEvent.click(versions)
  await userEvent.keyboard("{Escape}")
  await expect(canvas.getByRole("columnheader", { name: "Versions" })).toBeVisible()
}

function PerformanceScenario(props: ComponentProps<typeof PerformancePage>) {
  return (
    <StorybookProjectFrame
      projectId={`storybook-performance-${props.model}`}
      title={`${props.model === "agents" ? "Agents" : "Workflows"} performance`}
    >
      <PerformancePage {...props} />
    </StorybookProjectFrame>
  )
}

const meta = {
  title: "Tracer/Dashboards/PerformancePage",
  component: PerformancePage,
  args: { model: "agents", initialFilter: fixedFilter },
  parameters: {
    layout: "fullscreen",
    nextjs: {
      navigation: { pathname: `${storybookProject.prefix}/agents` },
    },
  },
  render: (args) => <PerformanceScenario {...args} />,
} satisfies Meta<typeof PerformancePage>

export default meta
type Story = StoryObj<typeof meta>

export const Agents: Story = {
  parameters: { msw: { handlers: [groupedPerformanceHandler("agents"), ...performanceHandlers()] } },
  play: async ({ canvasElement }) => {
    await checkCollectionPanel(canvasElement, "Agents")
    const canvas = within(canvasElement)
    await expect(canvas.findByText("Weather agent")).resolves.toBeVisible()
    await checkVersions(canvasElement, "Weather agent")
    await expect(
      canvas.getByRole("button", { name: "Next page" })
    ).toBeDisabled()
  },
}

export const FilterToEmpty: Story = {
  parameters: { msw: { handlers: performanceHandlers() } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const filter = await canvas.findByRole("combobox", {
      name: "Filter expression",
    })
    await userEvent.clear(filter)
    await userEvent.type(filter, 'name : "No match"')
    await userEvent.keyboard("{Enter}")
    await expect(
      canvas.findByRole("heading", { name: "No matching agents" })
    ).resolves.toBeVisible()
  },
}

export const Empty: Story = {
  args: { initialFilter: "" },
  parameters: { msw: { handlers: performanceHandlers("empty") } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("heading", {
        name: "No agents in this time range",
      })
    ).resolves.toBeVisible()
  },
}

export const Loading: Story = {
  parameters: { msw: { handlers: performanceHandlers("loading") } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("status")
    ).resolves.toHaveTextContent("Loading agents performance")
  },
}

export const ErrorAndRetry: Story = {
  parameters: {
    msw: {
      handlers: [
        metricsQueryHandler("error", { once: true }),
        metricsQueryHandler(),
        customFieldsHandler(),
        customViewsHandler(),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Performance metrics are unavailable."
    )
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }))
    await expect(canvas.findByText("Weather agent")).resolves.toBeVisible()
  },
}

export const Workflows: Story = {
  args: { model: "workflows", initialFilter: fixedFilter },
  parameters: {
    nextjs: {
      navigation: { pathname: `${storybookProject.prefix}/workflows` },
    },
    msw: { handlers: [groupedPerformanceHandler("workflows"), ...performanceHandlers()] },
  },
  play: async ({ canvasElement }) => {
    await checkCollectionPanel(canvasElement, "Workflows")
    await expect(
      within(canvasElement).findByText("Morning brief")
    ).resolves.toBeVisible()
    await checkVersions(canvasElement, "Morning brief")
  },
}

export const NarrowCollection: Story = {
  parameters: Agents.parameters,
  render: () => <div className="w-[375px] max-w-full"><PerformanceScenario model="agents" initialFilter={fixedFilter} /></div>,
  play: async ({ canvasElement }) => {
    await checkCompactCollectionPanel(canvasElement, "Agents")
  },
}

export const SelectionHeader: Story = {
  ...Agents,
  play: async ({ canvasElement }) => checkCollectionSelection(canvasElement, "Agents"),
}

export const WorkflowSelectionHeader: Story = {
  ...Workflows,
  play: async ({ canvasElement }) => checkCollectionSelection(canvasElement, "Workflows"),
}

export const NarrowSelectionHeader: Story = {
  ...NarrowCollection,
  play: async ({ canvasElement }) => checkCollectionSelection(canvasElement, "Agents"),
}
