import { checkCollectionSelection } from "../../.storybook/collection-panel-checks"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  customViewInputSchema,
  defaultTableSettings,
  type CustomViewInput,
} from "@/src/lib/tracer/custom-views"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { delay, http } from "msw"
import {
  StorybookProjectFrame,
  storybookProject,
} from "../../.storybook/component-frame"
import {
  data,
  datasetsEvalsHandlers,
  failure,
} from "../../.storybook/scenarios/datasets-evals/handlers"
import {
  list,
  evalRun,
  storybookEvalRunId,
  traceDetail,
  comparisonRun,
  evalComparison,
} from "../../.storybook/scenarios/datasets-evals/fixtures"
import { EvalDetailPage } from "./eval-run-detail"
import { InspectorPanels } from "./inspector-panels"
import type { EvalRunDetail } from "@/src/lib/tracer/contracts"

const scope = `${storybookProject.organizationId}:${storybookProject.projectId}`
let savedInput: CustomViewInput | undefined
const savedView = {
  id: "eval-display-view",
  name: "Tall review",
  resource: "eval-runs" as const,
  revision: 1,
  createdAt: "2026-09-13",
  updatedAt: "2026-09-13",
  settings: {
    ...defaultTableSettings,
    schemaVersion: 1 as const,
    rowHeight: "tall" as const,
    columnVisibility: { expected: false },
    computedColumns: [],
    columnOrder: ["name", "output", "input"],
    detailsOpen: false,
  },
}

const meta = {
  title: "Tracer/Evals/EvalRunDetail",
  component: EvalDetailPage,
  args: { runId: storybookEvalRunId },
  beforeEach: () => {
    localStorage.removeItem(`datool:eval-table:${scope}:${storybookEvalRunId}`)
    localStorage.removeItem(
      `datool:eval-column-order:${scope}:${storybookEvalRunId}`
    )
    savedInput = undefined
  },
  parameters: {
    layout: "fullscreen",
    nextjs: {
      navigation: {
        pathname: "/p/demo/evals/eval-run-storybook-baseline",
      },
    },
  },
  render: () => (
    <StorybookProjectFrame title="Evaluation run">
      <EvalDetailPage runId={storybookEvalRunId} />
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof EvalDetailPage>

export default meta
type Story = StoryObj<typeof meta>

export const ResultTable: Story = {
  parameters: { msw: { handlers: datasetsEvalsHandlers } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("heading", {
        name: "Invoice assistant · billing FAQ baseline",
      })
    ).resolves.toBeVisible()
  },
}

export const NarrowDetails: Story = {
  parameters: ResultTable.parameters,
  render: () => <StorybookProjectFrame title="Evaluation run" className="w-[390px] max-w-full"><EvalDetailPage runId={storybookEvalRunId} /></StorybookProjectFrame>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    const details = await canvas.findByRole("button", { name: "Details" })
    await waitFor(() => expect(details).toHaveAttribute("aria-haspopup", "dialog"))
    await expect(details).toHaveAttribute("aria-expanded", "false")
    await expect(canvas.queryByRole("separator", { name: "Resize workflow details" })).not.toBeInTheDocument()
    await expect(canvas.getByRole("table")).toBeVisible()
    const selectAll = canvas.getByRole("checkbox", { name: "Select all eval traces" })
    await userEvent.click(selectAll)
    await userEvent.click(details)
    const sheet = await body.findByRole("dialog", { name: "Run details" })
    const panel = within(sheet)
    await expect(panel.getByRole("heading", { name: evalRun.name! })).toBeVisible()
    await expect(panel.getByRole("button", { name: "Close" })).toHaveFocus()
    await userEvent.click(panel.getByRole("button", { name: /Scoring progress details/ }))
    await expect(panel.findByRole("progressbar", { name: "Scoring completion" })).resolves.toBeVisible()
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(panel.queryByRole("progressbar", { name: "Scoring completion" })).not.toBeInTheDocument())
    await expect(sheet).toBeVisible()
    await userEvent.click(panel.getByRole("button", { name: "Close" }))
    await waitFor(() => expect(body.queryByRole("dialog", { name: "Run details" })).not.toBeInTheDocument())
    await expect(details).toHaveFocus()
    await expect(selectAll).toBeChecked()
    await expect(canvas.getByRole("table")).toBeVisible()
  },
}

function deferredEvidenceStory({ retry = false, compare = false } = {}): Story {
  let requests: string[] = []
  return {
    render: () => (
      <StorybookProjectFrame title="Evaluation run">
        <InspectorPanels><EvalDetailPage runId={storybookEvalRunId} /></InspectorPanels>
      </StorybookProjectFrame>
    ),
    beforeEach: () => { requests = []; localStorage.removeItem("datool:trace-inspector:tab") },
    parameters: {
      nextjs: { navigation: { query: compare ? { compare: comparisonRun.id } : {} } },
      msw: { handlers: [
        http.get("/api/evals/compare", ({ request }) => {
          if (new URL(request.url).searchParams.get("includeEvidence") !== "false")
            return failure("Comparison requested full evidence")
          return data(evalComparison)
        }),
        http.get("/api/evals/:runId/targets/:targetId", async ({ params }) => {
          requests.push(`${params.runId}/${params.targetId}`)
          await delay(300)
          if (retry && requests.length === 1) return failure("Evidence temporarily unavailable")
          return data({ ...evalRun.rows![0], scoringTrace: { ...traceDetail, group: null, name: "Frozen eval evidence", spans: [] } })
        }),
        http.get("/api/evals/:runId", ({ request }) => {
          if (new URL(request.url).searchParams.get("includeEvidence") !== "false")
            return failure("Table requested full evidence")
          return data({ ...evalRun, rows: evalRun.rows!.map(row => ({ ...row, scoringTrace: undefined })) })
        }),
        ...datasetsEvalsHandlers,
      ] },
    },
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement)
      const row = await canvas.findByRole("row", { name: `${compare ? "Compared" : "Current"} run target 1` })
      expect(requests).toHaveLength(0)
      row.focus()
      await userEvent.keyboard("{Enter}")
      await expect(canvas.findByText("Loading eval evidence")).resolves.toBeVisible()
      if (retry) {
        await expect(canvas.findByText("Evidence temporarily unavailable")).resolves.toBeVisible()
        await userEvent.click(canvas.getByRole("button", { name: /^Retry$/ }))
      }
      await expect(canvas.findByRole("heading", { name: "Frozen eval evidence" })).resolves.toBeVisible()
      expect(requests).toHaveLength(retry ? 2 : 1)
      expect(requests[0]).toBe(`${compare ? comparisonRun.id : evalRun.id}/${compare ? comparisonRun.rows![0].id : evalRun.rows![0].id}`)
      await userEvent.click(canvas.getByRole("button", { name: "Close trace inspector" }))
      await waitFor(() => expect(row).toHaveFocus())
    },
  }
}

export const LazyEvidence = deferredEvidenceStory()
export const EvidenceRetry = deferredEvidenceStory({ retry: true })
export const LazyComparisonEvidence = deferredEvidenceStory({ compare: true })

export const NumericComparison: Story = {
  parameters: {
    nextjs: { navigation: { query: { compare: comparisonRun.id } } },
    msw: { handlers: datasetsEvalsHandlers },
  },
  render: () => <StorybookProjectFrame title="Evaluation comparison"><InspectorPanels><EvalDetailPage runId={storybookEvalRunId} /></InspectorPanels></StorybookProjectFrame>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const panel = within(await canvas.findByRole("complementary", { name: "Comparisons" }))
    const summary = within(await panel.findByRole("region", { name: "Average score comparison" }))
    await expect(summary.getByText("94%")).toBeVisible()
    await expect(summary.getByText("70%")).toBeVisible()
    await expect(summary.getByText("-24 pp")).toBeVisible()
    const candidate = within(await canvas.findByRole("row", { name: "Compared run target 1" }))
    await expect(candidate.getAllByText("+6 pp")).toHaveLength(2)
    await expect(candidate.getByText("−500ms")).toBeInTheDocument()
    const missing = within(canvas.getByRole("row", { name: "Compared run target 2" }))
    await expect(missing.getAllByText("No baseline")).toHaveLength(2)
    await expect(missing.getByText("+300ms")).toBeInTheDocument()
    await expect(panel.getByRole("combobox", { name: "Comparison runs" })).toBeVisible()
    // Keep numeric columns in view when this demonstration is opened.
    candidate.getAllByText("+6 pp")[0].scrollIntoView({ block: "nearest", inline: "center" })
  },
}

export const ComparisonLoading: Story = {
  parameters: {
    ...NumericComparison.parameters,
    msw: { handlers: [http.get("/api/evals/compare", async () => { await delay("infinite"); return data(evalComparison) }), ...datasetsEvalsHandlers] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("Loading comparison…")).resolves.toBeVisible()
    await expect(canvas.queryByText("No trace targets in this run.")).not.toBeInTheDocument()
  },
}

export const NarrowComparison: Story = {
  ...NumericComparison,
  render: () => <StorybookProjectFrame title="Evaluation comparison" className="w-[390px] max-w-full"><InspectorPanels><EvalDetailPage runId={storybookEvalRunId} /></InspectorPanels></StorybookProjectFrame>,
  play: async context => {
    const canvas = within(context.canvasElement)
    const body = within(context.canvasElement.ownerDocument.body)
    const compare = await canvas.findByRole("button", { name: "Compare" })
    await waitFor(() => expect(compare).toHaveAttribute("aria-haspopup", "dialog"))
    await expect(canvas.queryByRole("separator", { name: "Resize comparisons" })).not.toBeInTheDocument()
    await userEvent.click(compare)
    const sheet = await body.findByRole("dialog", { name: "Eval comparison" })
    const panel = within(sheet)
    const summary = within(await panel.findByRole("region", { name: "Average score comparison" }))
    await expect(summary.getByText("-24 pp")).toBeVisible()
    await userEvent.click(panel.getByRole("combobox", { name: "Comparison runs" }))
    await expect(panel.findByRole("listbox")).resolves.toBeVisible()
    await userEvent.keyboard("{Escape}")
    await expect(sheet).toBeVisible()
    await userEvent.click(panel.getByRole("button", { name: "Close" }))
    await waitFor(() => expect(body.queryByRole("dialog")).not.toBeInTheDocument())
    await expect(compare).toHaveFocus()
    await expect(canvas.getByRole("row", { name: "Compared run target 1" })).toBeVisible()
  },
}

export const ComparisonFailure: Story = {
  parameters: {
    ...NumericComparison.parameters,
    msw: { handlers: [http.get("/api/evals/compare", () => failure("Comparison is temporarily unavailable")), ...datasetsEvalsHandlers] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("Comparison is temporarily unavailable")).resolves.toBeVisible()
    await expect(canvas.queryByText("No trace targets in this run.")).not.toBeInTheDocument()
  },
}

const activeRun: EvalRunDetail = {
  ...evalRun,
  status: "running",
  completedAt: null,
  score: null,
  scores: [],
  resultCount: 0,
  results: [],
  evaluatorIds: [evalRun.evaluatorIds[0], "prompt-adherence"],
  scorerProgress: [
    { evaluatorId: evalRun.evaluatorIds[0], name: "Answer groundedness", version: 1, total: 2, queued: 1, running: 1, completed: 0, error: 0, skipped: 0, score: null },
    { evaluatorId: "prompt-adherence", name: "Prompt adherence", version: 2, total: 2, queued: 2, running: 0, completed: 0, error: 0, skipped: 0, score: null },
  ],
  rows: evalRun.rows!.map((row, index) => ({ ...row, results: [], scorerStatuses: {
    [evalRun.evaluatorIds[0]]: index === 0 ? "running" : "queued",
    "prompt-adherence": "queued",
  } })),
}

export const RunningScorers: Story = {
  parameters: { msw: { handlers: [
    http.get("/api/evals/:id", () => data(activeRun)),
    ...datasetsEvalsHandlers,
  ] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const table = within(await canvas.findByRole("table"))
    await expect(table.getByText("Running")).toBeVisible()
    await expect(table.getAllByText("Queued")).toHaveLength(3)
    await expect(canvas.getByRole("progressbar", { name: "Scoring progress" })).toHaveAttribute("aria-valuenow", "0")
    await expect(canvas.getByRole("button", { name: "Re-score saved traces" })).toBeDisabled()
    // The scorer column must be available before its first result exists.
    await expect(canvas.getByRole("columnheader", { name: /Prompt adherence/ })).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Details" }))
    await expect(canvas.queryByRole("region", { name: "Scorer progress" })).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("button", { name: "Details" }))
    await expect(canvas.findByRole("region", { name: "Scorer progress" })).resolves.toBeVisible()
  },
}

function RemountableEvalDetail() {
  const [mount, setMount] = useState(0)
  return (
    <StorybookProjectFrame title="Evaluation run">
      <Button onClick={() => setMount((value) => value + 1)}>
        Remount eval detail
      </Button>
      <EvalDetailPage key={mount} runId={storybookEvalRunId} />
    </StorybookProjectFrame>
  )
}

export const PersistentDisplay: Story = {
  parameters: ResultTable.parameters,
  render: () => <RemountableEvalDetail />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    const display = async () =>
      userEvent.click(await canvas.findByRole("button", { name: "Display" }))
    await display()
    await expect(
      body.getByRole("menuitemradio", { name: "Compact" })
    ).toHaveAttribute("aria-checked", "true")
    await userEvent.click(
      body.getByRole("menuitemcheckbox", { name: "Expected" })
    )
    await userEvent.click(body.getByRole("menuitemradio", { name: "Tall" }))
    await userEvent.click(
      canvas.getByRole("button", { name: "Remount eval detail" })
    )
    await display()
    await expect(
      body.getByRole("menuitemradio", { name: "Tall" })
    ).toHaveAttribute("aria-checked", "true")
    await expect(
      body.getByRole("menuitemcheckbox", { name: "Expected" })
    ).toHaveAttribute("aria-checked", "false")
    await userEvent.click(body.getByRole("menuitemradio", { name: "Card" }))
    await userEvent.click(
      canvas.getByRole("button", { name: "Remount eval detail" })
    )
    await expect(
      canvas.findByLabelText("Log cards scroll area")
    ).resolves.toBeVisible()
    await expect(
      canvas.queryByRole("term", { name: "Expected" })
    ).not.toBeInTheDocument()
    await display()
    await userEvent.click(body.getByRole("menuitemradio", { name: "Compact" }))
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Display" })).toHaveFocus()
    )
  },
}

export const SavedDisplaySettings: Story = {
  parameters: {
    nextjs: { navigation: { query: { view: savedView.id } } },
    msw: {
      handlers: [
        http.get("/api/custom-views", () => data([savedView])),
        http.get(`/api/custom-views/${savedView.id}`, () => data(savedView)),
        http.post("/api/custom-views", async ({ request }) => {
          savedInput = customViewInputSchema.parse(await request.json())
          return data({
            ...savedView,
            ...savedInput,
            id: "eval-display-created",
          })
        }),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(
        canvas.getByRole("combobox", { name: "Custom view" })
      ).toHaveTextContent("Tall review")
    )
    await expect(
      canvas.getByRole("button", { name: "Details" })
    ).toHaveAttribute("aria-expanded", "false")
    await expect(
      canvas.queryByRole("columnheader", { name: "Expected" })
    ).not.toBeInTheDocument()
    await expect(
      canvas.queryByLabelText("Unsaved changes")
    ).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("button", { name: "Display" }))
    await expect(
      body.getByRole("menuitemradio", { name: "Tall" })
    ).toHaveAttribute("aria-checked", "true")
    await userEvent.keyboard("{Escape}")
    await userEvent.click(canvas.getByRole("button", { name: "Details" }))
    await userEvent.click(canvas.getByRole("combobox", { name: "Custom view" }))
    await userEvent.click(
      await body.findByRole("button", { name: "Create new view with changes" })
    )
    const dialog = within(
      await body.findByRole("dialog", { name: "Save custom view" })
    )
    await userEvent.clear(dialog.getByRole("textbox"))
    await userEvent.type(dialog.getByRole("textbox"), "Tall with details")
    await userEvent.click(dialog.getByRole("button", { name: "Save view" }))
    await waitFor(() =>
      expect(savedInput?.settings).toMatchObject({
        rowHeight: "tall",
        detailsOpen: true,
        columnVisibility: { expected: false },
      })
    )
    await waitFor(() =>
      expect(
        body.queryByRole("dialog", { name: "Save custom view" })
      ).not.toBeInTheDocument()
    )
  },
}

export const LoadFailure: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/custom-fields", () => data([])),
        http.get("/api/evals/:runId", () =>
          failure("Evaluation run was not found", 404)
        ),
        http.get("/api/evals", () => data(list([]))),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("Evaluation run was not found")
    ).resolves.toBeVisible()
  },
}

const pagedRows = Array.from({ length: 60 }, (_, index) => ({
  ...evalRun.rows![0],
  id: `scroll-target-${index}`,
  trace: {
    ...evalRun.rows![0].trace,
    id: `scroll-trace-${index}`,
    name: `Scroll trace ${index + 1}`,
    input: `Question ${index + 1}`,
    output: `Answer ${index + 1}`,
  },
}))

function paginatedStory({
  cards = false,
  retry = false,
  compare = false,
} = {}): Story {
  let nextRequests = 0
  return {
    beforeEach: () => {
      nextRequests = 0
      localStorage.removeItem(
        `datool:eval-table:${scope}:${storybookEvalRunId}`
      )
      if (cards)
        localStorage.setItem(
          `datool:eval-table:${scope}:${storybookEvalRunId}`,
          JSON.stringify({ ...defaultTableSettings, view: "cards" })
        )
    },
    parameters: {
      nextjs: {
        navigation: { query: compare ? { compare: "scroll-comparison" } : {} },
      },
      msw: {
        handlers: [
          http.get("/api/custom-fields", () => data([])),
          http.get("/api/evals/compare", ({ request }) => {
            const offset = Number(
              new URL(request.url).searchParams.get("offset") ?? 0
            )
            if (offset) nextRequests++
            return data({
              left: evalRun,
              right: { ...evalRun, id: "scroll-comparison" },
              pairs: pagedRows
                .slice(offset, offset + 50)
                .map((row) => ({
                  id: row.id,
                  left: row,
                  right: { ...row, id: `compared-${row.id}` },
                })),
              total: 60,
              offset,
              limit: 50,
              nextOffset: offset === 0 ? 50 : null,
            })
          }),
          http.get("/api/evals/:runId", ({ request }) => {
            const cursor = new URL(request.url).searchParams.get("cursor")
            if (cursor) {
              nextRequests++
              if (retry && nextRequests === 1)
                return failure("Temporary page failure", 500)
            }
            return data({
              ...evalRun,
              rows: cursor ? pagedRows.slice(50) : pagedRows.slice(0, 50),
              nextCursor: cursor ? null : "page-two",
            })
          }),
          ...datasetsEvalsHandlers,
        ],
      },
    },
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement)
      const area = await canvas.findByLabelText(
        cards ? "Log cards scroll area" : "Log table scroll area"
      )
      await waitFor(() =>
        expect(canvas.getAllByText("Scroll trace 1").length).toBeGreaterThan(0)
      )
      await expect(
        canvas.queryByRole("button", {
          name: /Previous page|Next page|Load more/,
        })
      ).not.toBeInTheDocument()
      await expect(nextRequests).toBe(0)
      area.scrollTop = area.scrollHeight
      area.dispatchEvent(new Event("scroll"))
      if (retry) {
        await expect(
          canvas.findByText("Temporary page failure")
        ).resolves.toBeVisible()
        await expect(nextRequests).toBe(1)
        await userEvent.click(
          canvas.getByRole("button", { name: "Retry loading traces" })
        )
      }
      await waitFor(() => expect(nextRequests).toBe(retry ? 2 : 1))
      await waitFor(() =>
        expect(
          canvas.queryByText("Loading more traces…")
        ).not.toBeInTheDocument()
      )
      area.scrollTop = area.scrollHeight
      area.dispatchEvent(new Event("scroll"))
      await waitFor(() =>
        expect(canvas.getAllByText("Scroll trace 60").length).toBeGreaterThan(0)
      )
      area.scrollTop = 0
      area.dispatchEvent(new Event("scroll"))
      await waitFor(() =>
        expect(canvas.getAllByText("Scroll trace 1").length).toBeGreaterThan(0)
      )
      await expect(nextRequests).toBe(retry ? 2 : 1)
      if (!cards && !compare && !retry) {
        await expect(canvas.getByText("60 targets")).toBeVisible()
        await userEvent.click(canvas.getByRole("button", { name: "Refresh" }))
        await waitFor(() => expect(nextRequests).toBe(2))
        await expect(canvas.getByText("60 targets")).toBeVisible()
      }
    },
  }
}

export const InfiniteTableScroll = paginatedStory()
export const InfiniteCardScroll = paginatedStory({ cards: true })
export const InfiniteScrollRetry = paginatedStory({ retry: true })
export const InfiniteComparisonScroll = paginatedStory({ compare: true })

export const SelectionHeader: Story = {
  parameters: ResultTable.parameters,
  play: async ({ canvasElement }) => checkCollectionSelection(canvasElement, "Eval traces"),
}

export const NarrowSelectionHeader: Story = {
  ...SelectionHeader,
  render: () => (
    <StorybookProjectFrame title="Evaluation run" className="w-[390px] max-w-full">
      <EvalDetailPage runId={storybookEvalRunId} />
    </StorybookProjectFrame>
  ),
}

export const ComparisonSelectionHeader: Story = {
  parameters: NumericComparison.parameters,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole("row", { name: "Compared run target 1" })
    await checkCollectionSelection(canvasElement, "Eval traces")
  },
}

export const CardSelectionHeader: Story = {
  parameters: ResultTable.parameters,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("checkbox", { name: "Select all eval traces" })
    await userEvent.click(canvas.getByRole("button", { name: "Display" }))
    await userEvent.click(within(document.body).getByRole("menuitemradio", { name: "Card" }))
    await expect(canvas.getByLabelText("Log cards scroll area")).toBeVisible()
    await checkCollectionSelection(canvasElement, "Eval traces")
  },
}

export const Loading: Story = {
  parameters: {
    msw: { handlers: [
      http.get("/api/evals/:runId", async () => { await delay("infinite"); return data(evalRun) }),
      ...datasetsEvalsHandlers,
    ] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("Loading eval traces")).resolves.toBeVisible()
    await expect(canvas.queryByRole("group", { name: "Selected row actions" })).not.toBeInTheDocument()
  },
}

export const EmptyTargets: Story = {
  parameters: {
    msw: { handlers: [
      http.get("/api/evals/:runId", () => data({ ...evalRun, rows: [] })),
      ...datasetsEvalsHandlers,
    ] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("No trace targets in this run.")).resolves.toBeVisible()
    await expect(canvas.getByRole("checkbox", { name: "Select all eval traces" })).toBeDisabled()
    await expect(canvas.queryByRole("group", { name: "Selected row actions" })).not.toBeInTheDocument()
  },
}
