import {
  checkCollectionSelection,
  checkCollectionPanel,
  checkCompactCollectionPanel,
} from "../../.storybook/collection-panel-checks"
import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { getRouter } from "@storybook/nextjs-vite/navigation.mock"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { delay, http } from "msw"
import {
  StorybookProjectFrame,
  storybookProject,
} from "../../.storybook/component-frame"
import { Button } from "@/components/ui/button"
import {
  customViewInputSchema,
  type CustomView,
} from "@/src/lib/tracer/custom-views"
import {
  data,
  datasetsEvalsHandlers,
  failure,
} from "../../.storybook/scenarios/datasets-evals/handlers"
import {
  scorerRows,
  traceRows,
} from "../../.storybook/scenarios/datasets-evals/fixtures"
import { libraryScorerPreset } from "@/src/lib/tracer/scorers"
import { NewScorerPage, ScorerDetailPage, ScorersPage } from "./scorers-page"

const scorersHref = `${storybookProject.prefix}/scorers`
const scorerBreadcrumbs = [{ label: "Scorers", href: scorersHref }]
const detailParameters = {
  nextjs: { navigation: { pathname: `${scorersHref}/${scorerRows[0].id}` } },
  msw: { handlers: datasetsEvalsHandlers },
}
const renderScorerDetail = () => (
  <StorybookProjectFrame title="Scorer details" breadcrumbs={scorerBreadcrumbs}>
    <ScorerDetailPage scorerId={scorerRows[0].id} />
  </StorybookProjectFrame>
)

async function waitForScorerSave(button: HTMLElement) {
  await waitFor(async () => {
    await expect(button).toBeDisabled()
    await expect(button).not.toHaveAttribute("aria-busy", "true")
  })
}

const settingsKey = `datool:scorers:${storybookProject.organizationId}:${storybookProject.projectId}:settings`
const orderKey = "datool.scorers.columns"
const emptyViews = http.get("/api/custom-views", () => data([]))
const savedInput = fn()
const scorerView: CustomView = {
  id: "scorer-review-view",
  name: "Scorer review",
  resource: "scorers",
  revision: 1,
  createdAt: "2026-09-10T12:00:00Z",
  updatedAt: "2026-09-10T12:00:00Z",
  settings: {
    schemaVersion: 1,
    computedColumns: [],
    columnOrder: ["name", "type", "version", "updated", "slug", "description"],
    columnVisibility: { slug: false, description: false },
    columnSizing: { type: 210 },
    view: "table",
    detailsOpen: false,
  },
}

function ReloadableScorers() {
  const [version, setVersion] = useState(0)
  return (
    <>
      <Button
        variant="outline"
        onClick={() => setVersion((current) => current + 1)}
      >
        Remount scorer page
      </Button>
      <StorybookProjectFrame title="Scorers">
        <ScorersPage key={version} />
      </StorybookProjectFrame>
    </>
  )
}

const meta = {
  title: "Tracer/Scorers/ScorersPage",
  component: ScorersPage,
  beforeEach: () => {
    for (const key of Object.keys(localStorage)) {
      if (
        key.startsWith(
          `datool:scorer-draft:${storybookProject.organizationId}:${storybookProject.projectId}:`
        )
      )
        localStorage.removeItem(key)
    }
    localStorage.removeItem(settingsKey)
    localStorage.removeItem(orderKey)
    localStorage.removeItem(`datool:custom-view-history:${scorerView.id}`)
    localStorage.removeItem("datool:custom-view-history:scorer-created-view")
    savedInput.mockClear()
  },
  parameters: {
    layout: "fullscreen",
    nextjs: { navigation: { pathname: "/p/demo/scorers" } },
  },
  render: () => (
    <StorybookProjectFrame title="Scorers">
      <ScorersPage />
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof ScorersPage>

export default meta
type Story = StoryObj<typeof meta>

export const Catalog: Story = {
  parameters: { msw: { handlers: datasetsEvalsHandlers } },
  play: async ({ canvasElement }) => {
    await checkCollectionPanel(canvasElement, "Scorers")
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("Answer groundedness")
    ).resolves.toBeVisible()
    const header = within(canvas.getByRole("banner", { name: "Page controls" }))
    await expect(
      canvas.getAllByRole("heading", { name: "Scorers", level: 1 })
    ).toHaveLength(1)
    const controls = within(
      canvas.getByRole("group", { name: "Scorers controls" })
    )
    const filter = controls.getByRole("search", { name: "Filter scorers" })
    const input = within(filter).getByRole("combobox", {
      name: "Filter expression",
    })
    await expect(input).toBeVisible()
    await expect(within(filter).getAllByRole("combobox")).toHaveLength(1)
    await expect(
      controls.findByRole("combobox", { name: "Custom view" })
    ).resolves.toBeVisible()
    await expect(
      controls.getByRole("link", { name: "New scorer" })
    ).toHaveAttribute("href", `${scorersHref}/new`)
    await expect(
      canvas.getByRole("link", { name: "Answer groundedness" })
    ).toHaveAttribute("href", `${scorersHref}/${scorerRows[0].id}`)

    // Use the same field/value suggestions as the Traces filter bar.
    await userEvent.type(input, "type = ")
    await userEvent.click(
      await within(document.body).findByRole("option", { name: "javascript" })
    )
    await waitFor(() =>
      expect(canvas.queryByText("Clear support style")).not.toBeInTheDocument()
    )
    await expect(canvas.getByText("Answer groundedness")).toBeVisible()
    await userEvent.click(header.getByRole("heading", { name: "Scorers" }))
    await expect(within(filter).getByText("Type: Javascript")).toBeVisible()

    await userEvent.click(
      controls.getByRole("button", { name: "Clear search" })
    )
    await userEvent.type(input, 'type = "llm" name : "style"')
    await userEvent.keyboard("{Enter}")
    await waitFor(() =>
      expect(canvas.queryByText("Answer groundedness")).not.toBeInTheDocument()
    )
    await expect(canvas.getByText("Clear support style")).toBeVisible()

    // Unsubmitted text never changes the applied filters or shows an error.
    await userEvent.type(input, ' revision = "invalid"')
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
    await expect(canvas.getByText("Clear support style")).toBeVisible()
    await expect(
      canvas.queryByText("Answer groundedness")
    ).not.toBeInTheDocument()

    await userEvent.click(
      controls.getByRole("button", { name: "Clear search" })
    )
    await userEvent.type(input, 'name : "no matching scorer"')
    await userEvent.keyboard("{Enter}")
    await expect(
      canvas.findByText("No matching scorers")
    ).resolves.toBeVisible()
    await userEvent.click(
      controls.getByRole("button", { name: "Clear search" })
    )
    await expect(
      canvas.findByText("Answer groundedness")
    ).resolves.toBeVisible()
    await expect(canvas.getByText("Clear support style")).toBeVisible()
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
    getRouter().push.mockClear()
    await userEvent.click(
      canvas.getByRole("row", { name: /Select Answer groundedness/ })
    )
    await expect(getRouter().push).toHaveBeenCalledWith(
      `${scorersHref}/${scorerRows[0].id}`
    )
  },
}

export const Empty: Story = {
  parameters: {
    msw: { handlers: [emptyViews, http.get("/api/scorers", () => data([]))] },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("Create your first scorer")
    ).resolves.toBeVisible()
  },
}

export const LoadFailure: Story = {
  parameters: {
    msw: {
      handlers: [
        emptyViews,
        http.get("/api/scorers", () => failure("Could not load scorers")),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("alert")
    ).resolves.toHaveTextContent("Could not load scorers")
  },
}

export const NewScorerEditor: Story = {
  parameters: {
    msw: { handlers: datasetsEvalsHandlers },
    nextjs: { navigation: { pathname: `${scorersHref}/new` } },
  },
  render: () => (
    <StorybookProjectFrame title="New scorer" breadcrumbs={scorerBreadcrumbs}>
      <NewScorerPage />
    </StorybookProjectFrame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    getRouter().replace.mockClear()
    const header = within(canvas.getByRole("banner", { name: "Page controls" }))
    await expect(header.getByRole("link", { name: "Scorers" })).toHaveAttribute(
      "href",
      "/p/demo/scorers"
    )
    await expect(header.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Create scorer"
    )
    const controls = canvas.getByRole("group", { name: "Scorer controls" })
    await expect(within(controls).getByLabelText("Name")).toBeVisible()
    await expect(
      within(controls).queryByRole("combobox", { name: "Add data" })
    ).not.toBeInTheDocument()
    const addData = canvas.getByRole("combobox", { name: "Add data" })
    const testCase = canvas.getByRole("article", { name: "Test case JSON 1" })
    await expect(addData.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      testCase.getBoundingClientRect().bottom
    )
    await expect(
      within(controls).getByRole("button", { name: "Run all" })
    ).toBeVisible()
    await expect(controls.closest('[data-slot="resizable-panel"]')).toBeNull()
    const separator = canvas.getByRole("separator", {
      name: "Resize scorer panels",
    })
    await expect(separator.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      controls.getBoundingClientRect().bottom
    )
    await userEvent.type(canvas.getByLabelText("Name"), "Invoice match")
    await userEvent.click(canvas.getByRole("button", { name: "Javascript" }))
    await userEvent.click(canvas.getByRole("button", { name: "Save" }))
    await waitForScorerSave(canvas.getByRole("button", { name: "Save" }))
    await expect(getRouter().replace).not.toHaveBeenCalled()
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  },
}

const chainOfThoughtRequest = fn()
export const ChainOfThoughtScorer: Story = {
  parameters: {
    nextjs: { navigation: { pathname: `${scorersHref}/new` } },
    msw: {
      handlers: [
        http.post("/api/scorers/test", async ({ request }) => {
          chainOfThoughtRequest("test", await request.json())
          return data({
            score: 1,
            reasoning: "The evidence supports this score.",
          })
        }),
        http.post("/api/scorers", async ({ request }) => {
          chainOfThoughtRequest("save", await request.json())
          return data(scorerRows[1])
        }),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  render: () => (
    <StorybookProjectFrame title="New scorer" breadcrumbs={scorerBreadcrumbs}>
      <NewScorerPage />
    </StorybookProjectFrame>
  ),
  play: async ({ canvasElement }) => {
    chainOfThoughtRequest.mockClear()
    const canvas = within(canvasElement)
    const toggle = canvas.getByRole("switch", { name: "Chain of thought" })
    await expect(toggle).not.toBeChecked()
    await userEvent.type(canvas.getByLabelText("Name"), "Evidence assessment")
    await userEvent.click(canvas.getByRole("combobox", { name: "Model" }))
    const modelOptions = within(canvasElement.ownerDocument.body)
    await userEvent.type(
      await modelOptions.findByRole("combobox", { name: "Search model" }),
      "openai/gpt-4.1-mini"
    )
    await userEvent.click(
      within(await modelOptions.findByRole("group", { name: "Vercel AI Gateway" })).getByRole("option", { name: /GPT-4.1 mini/ })
    )
    await userEvent.click(toggle)
    await userEvent.click(canvas.getByRole("button", { name: "Run JSON 1" }))
    await waitFor(() =>
      expect(chainOfThoughtRequest).toHaveBeenLastCalledWith(
        "test",
        expect.objectContaining({
          config: expect.objectContaining({ chainOfThought: true }),
        })
      )
    )
    await canvas.findByRole("status", { name: "Scorer test result" })
    await userEvent.click(toggle)
    await expect(
      canvas.getByRole("heading", { name: "Preview the scorer - outdated" })
    ).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Run JSON 1" }))
    await waitFor(() =>
      expect(chainOfThoughtRequest).toHaveBeenLastCalledWith(
        "test",
        expect.objectContaining({
          config: expect.objectContaining({ chainOfThought: false }),
        })
      )
    )
    await canvas.findByRole("status", { name: "Scorer test result" })
    await userEvent.click(toggle)
    await userEvent.click(canvas.getByRole("button", { name: "Javascript" }))
    await expect(
      canvas.queryByRole("switch", { name: "Chain of thought" })
    ).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("button", { name: "LLM" }))
    await expect(
      canvas.getByRole("switch", { name: "Chain of thought" })
    ).toBeChecked()
    await userEvent.click(canvas.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(chainOfThoughtRequest).toHaveBeenLastCalledWith(
        "save",
        expect.objectContaining({ chainOfThought: true })
      )
    )
  },
}

export const EditScorerHeader: Story = {
  parameters: detailParameters,
  render: renderScorerDetail,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    getRouter().replace.mockClear()
    const header = within(canvas.getByRole("banner", { name: "Page controls" }))
    await expect(
      header.findByRole("heading", { name: "Answer groundedness", level: 1 })
    ).resolves.toBeVisible()
    await expect(canvas.getByLabelText("Name")).toHaveValue(
      "Answer groundedness"
    )
    await expect(
      header.queryByRole("button", { name: "Delete" })
    ).not.toBeInTheDocument()
    const controls = within(
      canvas.getByRole("group", { name: "Scorer controls" })
    )
    const deleteButton = controls.getByRole("button", { name: "Delete" })
    await expect(deleteButton).toBeVisible()
    await expect(deleteButton.nextElementSibling).toBe(
      controls.getByRole("button", { name: "Save" })
    )
    await expect(deleteButton).toHaveTextContent("")
    await expect(canvas.getByRole("button", { name: "Save" })).toBeVisible()
    const breadcrumb = within(
      header.getByRole("navigation", { name: "Breadcrumb" })
    )
    await expect(
      breadcrumb.getByRole("link", { name: "Scorers" })
    ).toHaveAttribute("href", scorersHref)
    const save = controls.getByRole("button", { name: "Save" })
    await expect(save).toBeDisabled()
    const name = canvas.getByLabelText("Name")
    await userEvent.type(name, " updated")
    await expect(save).toBeEnabled()
    await userEvent.clear(name)
    await userEvent.type(name, "Answer groundedness")
    await expect(save).toBeDisabled()
    await userEvent.type(name, " updated")
    await userEvent.click(save)
    await waitForScorerSave(save)
    await expect(getRouter().replace).not.toHaveBeenCalled()
    await expect(save).toBeDisabled()
  },
}

export const ScorerDetailLoading: Story = {
  parameters: {
    ...detailParameters,
    msw: {
      handlers: [
        http.get("/api/scorers/:scorerId", async () => {
          await delay("infinite")
          return data(scorerRows[0])
        }),
      ],
    },
  },
  render: renderScorerDetail,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByRole("status")).resolves.toHaveTextContent(
      "Loading scorer"
    )
    await expect(canvas.getByRole("link", { name: "Scorers" })).toHaveAttribute(
      "href",
      scorersHref
    )
    await expect(
      canvas.queryByRole("button", { name: "Save" })
    ).not.toBeInTheDocument()
  },
}

export const ScorerDetailRetry: Story = {
  parameters: {
    ...detailParameters,
    msw: {
      handlers: [
        http.get(
          "/api/scorers/:scorerId",
          () => failure("Could not load scorer"),
          { once: true }
        ),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  render: renderScorerDetail,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Could not load scorer"
    )
    await expect(canvas.getByRole("link", { name: "Scorers" })).toHaveAttribute(
      "href",
      scorersHref
    )
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }))
    await expect(canvas.findByLabelText("Name")).resolves.toHaveValue(
      "Answer groundedness"
    )
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  },
}

export const ScorerNotFound: Story = {
  parameters: {
    ...detailParameters,
    msw: {
      handlers: [
        http.get("/api/scorers/:scorerId", () =>
          failure("Scorer not found", 404)
        ),
      ],
    },
  },
  render: renderScorerDetail,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Scorer not found"
    )
    await expect(canvas.getByRole("link", { name: "Scorers" })).toHaveAttribute(
      "href",
      scorersHref
    )
    await expect(
      canvas.queryByRole("button", { name: "Save" })
    ).not.toBeInTheDocument()
  },
}

export const DeleteScorer: Story = {
  parameters: detailParameters,
  render: renderScorerDetail,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    getRouter().replace.mockClear()
    await userEvent.click(await canvas.findByRole("button", { name: "Delete" }))
    await expect(getRouter().replace).not.toHaveBeenCalled()
    await userEvent.click(
      canvas.getByRole("button", { name: "Confirm delete" })
    )
    await waitFor(() =>
      expect(getRouter().replace).toHaveBeenCalledWith(scorersHref)
    )
  },
}

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        emptyViews,
        http.get("/api/scorers", async () => {
          await delay("infinite")
          return data([])
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("Loading scorers")).resolves.toBeVisible()
    await expect(
      within(canvas.getByRole("group", { name: "Scorers controls" })).getByRole(
        "link",
        { name: "New scorer" }
      )
    ).toBeVisible()
    await expect(
      canvas.queryByText("Create your first scorer")
    ).not.toBeInTheDocument()
  },
}

export const Narrow: Story = {
  parameters: { msw: { handlers: datasetsEvalsHandlers } },
  render: () => (
    <div className="w-[375px] max-w-full">
      <StorybookProjectFrame title="Scorers">
        <ScorersPage />
      </StorybookProjectFrame>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("Answer groundedness")
    ).resolves.toBeVisible()
    const header = canvas.getByRole("group", { name: "Scorers controls" })
    await checkCompactCollectionPanel(canvasElement, "Scorers")
    await expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth)
    await expect(header.getBoundingClientRect().height).toBeLessThan(60)
    await expect(
      within(header)
        .getByRole("combobox", { name: "Filter expression" })
        .getBoundingClientRect().width
    ).toBeGreaterThan(120)
    await expect(
      within(header).getByRole("link", { name: "New scorer" })
    ).toBeVisible()
  },
}

export const RefreshFailure: Story = {
  parameters: {
    msw: {
      handlers: [
        emptyViews,
        http.get("/api/scorers", () => data(scorerRows), { once: true }),
        http.get("/api/scorers", () => failure("Scorer refresh failed")),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("Answer groundedness")
    ).resolves.toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Refresh" }))
    await waitFor(() =>
      expect(canvas.getByRole("alert")).toHaveTextContent(
        "Scorer refresh failed"
      )
    )
    await expect(canvas.getByText("Answer groundedness")).toBeVisible()
    await expect(canvas.getByRole("link", { name: "New scorer" })).toBeVisible()
  },
}

export const SavedDisplay: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/custom-views", ({ request }) => {
          return data(
            new URL(request.url).searchParams.get("resource") === "scorers"
              ? [scorerView]
              : []
          )
        }),
        http.get(`/api/custom-views/${scorerView.id}`, () => data(scorerView)),
        http.post("/api/custom-views", async ({ request }) => {
          const input = customViewInputSchema.parse(await request.json())
          savedInput(input)
          return data({ ...scorerView, ...input, id: "scorer-created-view" })
        }),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  render: () => <ReloadableScorers />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await expect(
      canvas.findByText("Answer groundedness")
    ).resolves.toBeVisible()
    await expect(
      canvas.getAllByRole("button", { name: "Display" })
    ).toHaveLength(1)
    await userEvent.click(canvas.getByRole("button", { name: "Display" }))
    const nameColumn = body.getByRole("menuitemcheckbox", { name: "Name" })
    await expect(nameColumn).toHaveAttribute("aria-disabled", "true")
    await userEvent.click(body.getByRole("menuitemcheckbox", { name: "Slug" }))
    await userEvent.keyboard("{Escape}")
    await expect(
      canvas.queryByRole("columnheader", { name: "Slug" })
    ).not.toBeInTheDocument()
    await userEvent.click(
      canvas.getByRole("button", { name: "Remount scorer page" })
    )
    await expect(
      canvas.findByText("Answer groundedness")
    ).resolves.toBeVisible()
    await expect(
      canvas.queryByRole("columnheader", { name: "Slug" })
    ).not.toBeInTheDocument()

    // Apply the same saved-view contract as Agents and Playground.
    await userEvent.click(canvas.getByRole("combobox", { name: "Custom view" }))
    await userEvent.click(
      await body.findByRole("option", { name: "Scorer review" })
    )
    await waitFor(() =>
      expect(
        canvas.queryByRole("columnheader", { name: "Description" })
      ).not.toBeInTheDocument()
    )
    await expect(
      canvas
        .getAllByRole("columnheader")
        .slice(1)
        .map((heading) => heading.textContent)
    ).toEqual(["Name", "Type", "Version", "Updated"])
    await expect(
      canvas.getByRole("columnheader", { name: "Type" }).getBoundingClientRect()
        .width
    ).toBe(210)

    await userEvent.click(canvas.getByRole("button", { name: "Display" }))
    await userEvent.click(body.getByRole("menuitemradio", { name: "Card" }))
    await expect(canvas.getAllByRole("article")).toHaveLength(2)
    await userEvent.click(canvas.getByRole("combobox", { name: "Custom view" }))
    await userEvent.click(
      await body.findByRole("button", { name: "Create new view with changes" })
    )
    const dialog = within(
      await body.findByRole("dialog", { name: "Save custom view" })
    )
    await userEvent.clear(dialog.getByLabelText("View name"))
    await userEvent.type(dialog.getByLabelText("View name"), "Scorer cards")
    await userEvent.click(dialog.getByRole("button", { name: "Save view" }))
    await waitFor(() =>
      expect(savedInput).toHaveBeenCalledWith({
        name: "Scorer cards",
        resource: "scorers",
        settings: { ...scorerView.settings, view: "cards" },
      })
    )
    await waitFor(() =>
      expect(
        canvas.getByRole("combobox", { name: "Custom view" })
      ).toHaveTextContent("Scorer cards")
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Remount scorer page" })
    )
    await expect(canvas.findAllByRole("article")).resolves.toHaveLength(2)
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  },
}

export const TestSelectedTraces: Story = {
  parameters: {
    nextjs: { navigation: { pathname: `${scorersHref}/new` } },
    msw: {
      handlers: [
        http.get("/api/traces/:id/payload", ({ params }) =>
          data({
            ...traceRows.find((trace) => trace.id === params.id),
            input: { full: String(params.id) },
            output: "Full recorded output",
          })
        ),
        http.post("/api/scorers/test", async ({ request }) => {
          const input = (await request.json()) as {
            traceId?: string
            sample?: unknown
          }
          await delay(80)
          if (input.sample || !input.traceId)
            return failure("Expected recorded evidence", 400)
          return data({
            traceId: input.traceId,
            result: { score: input.traceId === traceRows[0].id ? 1 : 0 },
            persisted: false,
          })
        }),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  render: () => (
    <StorybookProjectFrame title="New scorer" breadcrumbs={scorerBreadcrumbs}>
      <NewScorerPage
        traceIds={traceRows.slice(0, 2).map((trace) => trace.id)}
      />
    </StorybookProjectFrame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Javascript" }))
    const first = within(
      await canvas.findByRole("article", {
        name: `Test case ${traceRows[0].name}`,
      })
    )
    await expect(
      first.getByText("Full recorded output", { exact: false })
    ).toBeVisible()
    await userEvent.click(
      first.getByRole("button", { name: `Run ${traceRows[0].name}` })
    )
    await waitFor(() =>
      expect(
        first.getByRole("status", { name: "Scorer test result" })
      ).toHaveTextContent('"score": 1')
    )
    await userEvent.click(canvas.getByRole("button", { name: traceRows[1].id }))
    const second = within(
      await canvas.findByRole("article", {
        name: `Test case ${traceRows[1].name}`,
      })
    )
    await userEvent.click(
      second.getByRole("button", { name: `Run ${traceRows[1].name}` })
    )
    await waitFor(() =>
      expect(
        second.getByRole("status", { name: "Scorer test result" })
      ).toHaveTextContent('"score": 0')
    )
    await expect(
      first.getByRole("status", { name: "Scorer test result" })
    ).toHaveTextContent('"score": 1')
    await userEvent.click(
      second.getByRole("button", { name: traceRows[1].name! })
    )
    await expect(
      second.queryByRole("status", { name: "Scorer test result" })
    ).not.toBeInTheDocument()
    await expect(
      second.getByRole("status", { name: `Result for ${traceRows[1].name}` })
    ).toHaveTextContent("0%")
    await userEvent.click(canvas.getByRole("button", { name: "Run all" }))
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Run all" })).toBeEnabled()
    )
    await expect(
      first.getByRole("status", { name: "Scorer test result" })
    ).toHaveTextContent('"score": 1')
  },
}

const batchRequest = fn()
export const MultipleJsonTests: Story = {
  ...NewScorerEditor,
  parameters: {
    ...NewScorerEditor.parameters,
    msw: {
      handlers: [
        http.post("/api/scorers/test", async ({ request }) => {
          const input = await request.json()
          batchRequest(input)
          await delay(150)
          if (batchRequest.mock.calls.length === 1)
            return failure("Judge unavailable. Retry this case.", 503)
          return data({
            score: 0.75,
            passed: true,
            reasoning: "Matches the expected answer.",
          })
        }),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    batchRequest.mockClear()
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole("button", { name: "Run JSON 1" }))
    await expect(
      canvas.getByRole("button", { name: "Run JSON 1" })
    ).toBeDisabled()
    const runError = await canvas.findByRole("alert")
    await expect(runError).toHaveTextContent("Judge unavailable")
    await expect(
      runError.closest("details")?.querySelector("summary")
    ).toHaveTextContent("Run result")
    await userEvent.click(canvas.getByRole("combobox", { name: "Add data" }))
    await userEvent.click(await body.findByRole("option", { name: "JSON" }))
    await expect(canvas.getAllByRole("article")).toHaveLength(2)
    const editor = await canvas.findByRole(
      "textbox",
      { name: "JSON 1 sample" },
      { timeout: 10_000 }
    )
    await userEvent.click(editor)
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}")
    await expect(canvas.getByRole("button", { name: "Run all" })).toBeDisabled()
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}")
    await waitFor(() => expect(batchRequest).toHaveBeenCalledTimes(3))
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Run all" })).toBeEnabled()
    )
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
    for (const number of [1, 2]) {
      await expect(
        canvas.getByRole("status", { name: `Result for JSON ${number}` })
      ).toHaveTextContent("75%")
    }
    await userEvent.click(canvas.getByRole("button", { name: "Remove JSON 1" }))
    await userEvent.click(canvas.getByRole("button", { name: "Remove JSON 2" }))
    await expect(
      canvas.getByRole("heading", { name: "Add data to test your scorer" })
    ).toBeVisible()
    await expect(canvas.getByRole("button", { name: "Run all" })).toBeDisabled()
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}")
    await expect(batchRequest).toHaveBeenCalledTimes(3)
  },
}

const traceFilterRequest = fn()
export const AddFilteredTraces: Story = {
  ...NewScorerEditor,
  parameters: {
    ...NewScorerEditor.parameters,
    msw: {
      handlers: [
        http.get("/api/traces", ({ request }) => {
          const filter = new URL(request.url).searchParams.get("filter") ?? ""
          traceFilterRequest(filter)
          return data({
            items: filter.includes("completed")
              ? traceRows.slice(0, 1)
              : traceRows,
            nextCursor: null,
            total: traceRows.length,
          })
        }),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    traceFilterRequest.mockClear()
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole("combobox", { name: "Add data" }))
    await expect(
      canvasElement.ownerDocument.querySelector('[data-slot="dialog-content"]')
    ).not.toBeInTheDocument()
    const search = await body.findByRole("combobox", {
      name: "Search add data",
    })
    await userEvent.type(search, 'status = "completed"')
    await waitFor(() =>
      expect(traceFilterRequest).toHaveBeenLastCalledWith(
        'status = "completed"'
      )
    )
    await userEvent.click(
      await body.findByRole("option", { name: new RegExp(traceRows[0].name) })
    )
    await expect(
      canvasElement.ownerDocument.querySelector('[data-slot="dialog-content"]')
    ).not.toBeInTheDocument()
    await expect(canvas.getAllByRole("article")).toHaveLength(2)
    await expect(
      canvas.getByRole("article", { name: `Test case ${traceRows[0].name}` })
    ).toBeVisible()
  },
}

export const ScorerEditorNarrow: Story = {
  ...NewScorerEditor,
  render: () => (
    <div className="w-80 max-w-full">
      <StorybookProjectFrame title="New scorer" breadcrumbs={scorerBreadcrumbs}>
        <NewScorerPage />
      </StorybookProjectFrame>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const title = canvas.getByLabelText("Name")
    await userEvent.type(
      title,
      "A long scorer title that must fit beside the Save button on a small screen"
    )
    const configuration = canvas.getByRole("region", {
      name: "Scorer configuration",
    })
    const controls = canvas.getByRole("group", { name: "Scorer controls" })
    await expect(controls.scrollWidth).toBeLessThanOrEqual(controls.clientWidth)
    await expect(configuration.scrollWidth).toBeLessThanOrEqual(
      configuration.clientWidth
    )
    const panel = canvas.getByRole("region", { name: "Scorer tests" })
    await expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth)
    await expect(panel.getBoundingClientRect().top).toBeGreaterThan(
      configuration.getBoundingClientRect().top
    )
    await userEvent.click(canvas.getByRole("button", { name: "Run all" }))
    await waitFor(() =>
      expect(
        canvas.getByRole("status", { name: "Result for JSON 1" })
      ).toHaveTextContent("100%")
    )
    await expect(
      canvas.getByRole("button", { name: "JSON 1" }).getBoundingClientRect()
        .width
    ).toBeGreaterThan(100)
    await expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth)
  },
}

export const InvalidJsonIsolation: Story = {
  ...NewScorerEditor,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    const input = await canvas.findByRole(
      "textbox",
      { name: "JSON 1 sample" },
      { timeout: 10000 }
    )
    const { monaco } = await import("./monaco-runtime")
    const editor = monaco.editor
      .getEditors()
      .find((item) => item.getDomNode()?.contains(input))!
    await userEvent.click(input)
    editor.trigger("storybook", "editor.action.selectAll", undefined)
    await userEvent.paste('{"input":')
    await userEvent.click(canvas.getByRole("combobox", { name: "Add data" }))
    await userEvent.click(await body.findByRole("option", { name: "JSON" }))
    await userEvent.click(canvas.getByRole("button", { name: "Run all" }))
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Enter valid JSON"
    )
    await waitFor(() =>
      expect(
        canvas.getByRole("status", { name: "Result for JSON 2" })
      ).toHaveTextContent("100%")
    )
    await userEvent.click(input)
    editor.trigger("storybook", "editor.action.selectAll", undefined)
    await userEvent.paste('{"input":"test","output":"test"}')
    await userEvent.click(canvas.getByRole("button", { name: "Run JSON 1" }))
    await waitFor(() =>
      expect(
        canvas.getByRole("status", { name: "Result for JSON 1" })
      ).toHaveTextContent("100%")
    )
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  },
}

export const AddDataPaginationAndRetry: Story = {
  ...NewScorerEditor,
  parameters: {
    ...NewScorerEditor.parameters,
    msw: {
      handlers: [
        http.get("/api/traces", () => failure("Trace lookup failed"), {
          once: true,
        }),
        http.get("/api/traces", ({ request }) => {
          const cursor = new URL(request.url).searchParams.get("cursor")
          return data({
            items: cursor ? traceRows.slice(1, 2) : traceRows.slice(0, 1),
            nextCursor: cursor ? null : "page-two",
            total: 2,
          })
        }),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole("combobox", { name: "Add data" }))
    await expect(body.findByText("Trace lookup failed")).resolves.toBeVisible()
    await userEvent.click(body.getByRole("button", { name: "Retry traces" }))
    await body.findByRole("option", { name: new RegExp(traceRows[0].id) })
    await expect(
      body.queryByRole("button", { name: "Load more traces" })
    ).not.toBeInTheDocument()
    await userEvent.click(
      await body.findByRole("option", { name: new RegExp(traceRows[1].id) })
    )
    await expect(
      canvas.getByRole("article", { name: `Test case ${traceRows[1].name}` })
    ).toBeVisible()
    await userEvent.click(canvas.getByRole("combobox", { name: "Add data" }))
    await expect(
      body.queryByRole("option", { name: new RegExp(traceRows[1].id) })
    ).not.toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
    await waitFor(() =>
      expect(
        canvas.getByRole("combobox", { name: "Add data" })
      ).toHaveFocus()
    )
  },
}

export const CollapsibleConfiguration: Story = {
  ...NewScorerEditor,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Javascript" }))
    const code = await canvas.findByRole(
      "textbox",
      { name: "Scorer code" },
      { timeout: 10000 }
    )
    const codeSection = canvas.getByText("Javascript Code").closest("details")!
    await userEvent.click(canvas.getByText("Javascript Code"))
    await expect(codeSection).not.toHaveAttribute("open")
    await expect(code).not.toBeVisible()
    await userEvent.click(canvas.getByText("Javascript Code"))
    await expect(code).toBeVisible()
    const description = canvas.getByRole("textbox", { name: "Description" })
    await userEvent.type(description, "Keep this draft")
    await userEvent.click(
      canvas.getByText("Description", { selector: "summary span" })
    )
    await expect(description).not.toBeVisible()
    // Updating a neighboring field must not reopen or erase collapsed sections.
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Slug" }),
      "-edited"
    )
    await expect(description).not.toBeVisible()
    await userEvent.click(
      canvas.getByText("Description", { selector: "summary span" })
    )
    await expect(description).toHaveValue("Keep this draft")
    await userEvent.click(canvas.getByRole("button", { name: "LLM" }))
    const message = await canvas.findByRole(
      "textbox",
      { name: "Message 1" },
      { timeout: 10000 }
    )
    await userEvent.click(
      canvas.getByText("Messages", { selector: "summary span" })
    )
    await expect(message).not.toBeVisible()
    await userEvent.click(
      canvas.getByText("Choice scores", { selector: "summary span" })
    )
    await expect(canvas.getByLabelText("Choice 1")).not.toBeVisible()
    await userEvent.click(
      canvas.getByText("Messages", { selector: "summary span" })
    )
    await expect(message).toBeVisible()
  },
}

const rerunRequest = fn()
export const RerunKeepsResult: Story = {
  ...NewScorerEditor,
  parameters: {
    ...NewScorerEditor.parameters,
    msw: {
      handlers: [
        http.post("/api/scorers/test", async () => {
          rerunRequest()
          const rerun = rerunRequest.mock.calls.length > 1
          if (rerun) await delay(600)
          return data({
            score: rerun ? 0 : 1,
            passed: !rerun,
            reasoning: rerun ? "Updated result" : "Previous result",
          })
        }),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    rerunRequest.mockClear()
    const canvas = within(canvasElement)
    const run = canvas.getByRole("button", { name: "Run JSON 1" })
    await userEvent.click(run)
    const result = await canvas.findByRole("status", {
      name: "Scorer test result",
    })
    await expect(result).toHaveTextContent("Previous result")
    const passed = canvas.getByRole("img", { name: "Passed" })
    await userEvent.hover(passed)
    await expect(
      within(canvasElement.ownerDocument.body).findByRole("tooltip")
    ).resolves.toHaveTextContent("Passed")
    await userEvent.unhover(passed)
    const row = canvas.getByRole("article", { name: "Test case JSON 1" })
    const height = row.getBoundingClientRect().height
    await userEvent.click(run)
    await expect(run).toBeDisabled()
    await expect(result).toHaveTextContent("Previous result")
    await expect(result.parentElement).toHaveClass("blur-sm")
    await expect(canvas.getByRole("img", { name: "Running" })).toHaveClass(
      "bg-warning"
    )
    await expect(
      Math.abs(row.getBoundingClientRect().height - height)
    ).toBeLessThanOrEqual(1)
    await waitFor(() => expect(result).toHaveTextContent("Updated result"))
    await expect(result.parentElement).not.toHaveClass("blur-sm")
    await expect(canvas.getByRole("img", { name: "Failed" })).toHaveClass(
      "bg-destructive"
    )
    await expect(run).toBeEnabled()
  },
}

const pickerPages = Array.from({ length: 100 }, (_, index) => ({
  ...traceRows[0],
  id: `virtual-trace-${index}`,
  name: `Virtual trace ${index}`,
}))
const pickerPageRequest = fn()
let failPickerNextPage = true

export const VirtualTracePagination: Story = {
  ...NewScorerEditor,
  parameters: {
    ...NewScorerEditor.parameters,
    msw: {
      handlers: [
        http.get("/api/traces", async ({ request }) => {
          const cursor = new URL(request.url).searchParams.get("cursor")
          pickerPageRequest(cursor)
          if (!cursor) failPickerNextPage = true
          if (cursor && failPickerNextPage) {
            failPickerNextPage = false
            return failure("Next page failed")
          }
          if (cursor) await delay(150)
          return data({
            items: cursor ? pickerPages.slice(50) : pickerPages.slice(0, 50),
            nextCursor: cursor ? null : "second",
            total: 100,
          })
        }),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole("combobox", { name: "Add data" }))
    await body.findByRole("option", { name: /Virtual trace 0 / })
    const list = body.getByRole("listbox", { name: "Add data options" })
    await expect(within(list).getAllByRole("option").length).toBeLessThan(25)
    await expect(
      body.queryByRole("button", { name: "Load more traces" })
    ).not.toBeInTheDocument()
    list.scrollTop = list.scrollHeight
    list.dispatchEvent(new Event("scroll"))
    await expect(body.findByText("Next page failed")).resolves.toBeVisible()
    await userEvent.click(
      body.getByRole("button", { name: "Retry loading traces" })
    )
    await waitFor(() =>
      expect(within(list).getAllByRole("option")[0]).toHaveAttribute(
        "aria-setsize",
        "101"
      )
    )
    // Keyboard navigation must reach options that have never been mounted.
    await userEvent.click(
      body.getByRole("combobox", { name: "Search add data" })
    )
    await userEvent.keyboard("{ArrowDown}{End}")
    const last = await body.findByRole("option", { name: /Virtual trace 99 / })
    await expect(last).toBeVisible()
    await expect(within(list).getAllByRole("option").length).toBeLessThan(25)
    await userEvent.keyboard("{Enter}")
    await expect(
      canvas.getByRole("article", { name: "Test case Virtual trace 99" })
    ).toBeVisible()
  },
}

const pythonEditorSave = fn()
export const PythonScorerEditor: Story = {
  ...NewScorerEditor,
  parameters: {
    ...NewScorerEditor.parameters,
    msw: {
      handlers: [
        http.post("/api/scorers", async ({ request }) => {
          pythonEditorSave(await request.json())
          return data(scorerRows[0])
        }),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Name" }),
      "Python quality"
    )
    await userEvent.click(canvas.getByRole("button", { name: "Python" }))
    await expect(canvas.getByText("Python Code", { exact: true })).toBeVisible()
    const input = await canvas.findByRole(
      "textbox",
      { name: "Scorer code" },
      { timeout: 10000 }
    )
    const { monaco } = await import("./monaco-runtime")
    const editor = monaco.editor
      .getEditors()
      .find((item) => item.getDomNode()?.contains(input))!
    await expect(editor.getModel()?.getLanguageId()).toBe("python")
    await expect(editor.getValue()).toContain(
      "def evaluate(trace, dataset_item=None):"
    )
    await userEvent.click(input)
    editor.trigger("storybook", "editor.action.selectAll", undefined)
    const pythonCode =
      'def evaluate(trace, dataset_item=None):\n    return {"score": 0.8}\n'
    await userEvent.paste(pythonCode)
    await userEvent.click(canvas.getByRole("button", { name: "Javascript" }))
    await waitFor(() =>
      expect(
        monaco.editor
          .getEditors()
          .some(
            (item) =>
              item.getModel()?.getLanguageId() === "javascript" &&
              item.getValue().includes("function evaluate(")
          )
      ).toBe(true)
    )
    await userEvent.click(canvas.getByRole("button", { name: "LLM" }))
    await userEvent.click(canvas.getByRole("button", { name: "Python" }))
    const returnedInput = await canvas.findByRole("textbox", {
      name: "Scorer code",
    })
    const returnedEditor = monaco.editor
      .getEditors()
      .find((item) => item.getDomNode()?.contains(returnedInput))!
    await expect(returnedEditor.getValue()).toBe(pythonCode)
    await userEvent.click(canvas.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(pythonEditorSave).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "python", code: pythonCode })
      )
    )
  },
}

export const ModelErrorAttention: Story = {
  ...NewScorerEditor,
  parameters: {
    ...NewScorerEditor.parameters,
    msw: {
      handlers: [
        http.post("/api/scorers/test", async ({ request }) => {
          const input = (await request.json()) as { config: { model: string } }
          if (!input.config.model)
            return failure("Select a model for the LLM scorer.", 400)
          return data({
            score: null,
            passed: null,
            error: {
              kind: "runtime",
              message:
                "Vercel AI Gateway requires paid credits for this model.",
            },
            metadata: { judgeHttpStatus: 403 },
          })
        }),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    const model = canvas.getByRole("combobox", { name: "Model" })
    const run = canvas.getByRole("button", { name: "Run JSON 1" })
    await userEvent.click(run)
    await waitFor(() => expect(model).toHaveFocus())
    await expect(model).toHaveAttribute("aria-invalid", "true")
    await expect(
      canvas.getByText("Select a model for the LLM scorer.")
    ).toBeVisible()
    // A second failed attempt must move focus back again.
    await userEvent.click(run)
    await waitFor(() => expect(model).toHaveFocus())
    await userEvent.click(model)
    await userEvent.click(
      within(await page.findByRole("group", { name: "Vercel AI Gateway" })).getByRole("option", { name: /GPT-4.1 mini/ })
    )
    await expect(model).not.toHaveAttribute("aria-invalid")
    await userEvent.click(run)
    await waitFor(() => expect(model).toHaveFocus())
    await expect(model).toHaveAttribute("aria-invalid", "true")
    await expect(
      canvas.getByText(
        "Vercel AI Gateway requires paid credits for this model.",
        { exact: true }
      )
    ).toBeVisible()
  },
}

function DraftScorerHarness() {
  const [version, setVersion] = useState(0)
  return (
    <>
      <Button onClick={() => setVersion((value) => value + 1)}>
        Reopen scorer
      </Button>
      <StorybookProjectFrame title="New scorer" breadcrumbs={scorerBreadcrumbs}>
        <NewScorerPage key={version} />
      </StorybookProjectFrame>
    </>
  )
}

export const NativeEvaluationModel: Story = {
  ...NewScorerEditor,
  parameters: {
    ...NewScorerEditor.parameters,
    msw: {
      handlers: [
        http.post("/api/scorers", async ({ request }) => {
          const input = await request.json() as Record<string, unknown>
          savedInput(input)
          return data({ ...input, id: "native-evaluation-scorer", revision: 1 })
        }),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  render: () => <DraftScorerHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    await userEvent.type(await canvas.findByLabelText("Name"), "Refund evaluation")
    await userEvent.click(canvas.getByRole("switch", { name: "Chain of thought" }))
    await userEvent.type(canvas.getByLabelText("Custom Image Path"), "output.image.url")
    const select = async (searchText: string, optionName: RegExp) => {
      await userEvent.click(canvas.getByRole("combobox", { name: "Model" }))
      const search = await page.findByRole("combobox", { name: "Search model" })
      await waitFor(() => expect(search).toHaveFocus())
      await userEvent.type(search, searchText)
      await userEvent.click(await within(await page.findByRole("group", { name: "Vercel AI Gateway" })).findByRole("option", { name: optionName }))
      await waitFor(() => expect(page.queryByRole("listbox")).not.toBeInTheDocument())
    }
    await select("Jev", /Jev/)
    await expect(canvas.queryByLabelText("Custom Image Path")).not.toBeInTheDocument()
    await expect(canvas.queryByRole("switch", { name: "Chain of thought" })).not.toBeInTheDocument()
    await expect(canvas.getByText(/without a written explanation/)).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Reopen scorer" }))
    await waitFor(() =>
      expect(canvas.getByRole("combobox", { name: "Model" })).toHaveTextContent("Jev")
    )
    const save = canvas.getByRole("button", { name: "Save" })
    await userEvent.click(save)
    await waitForScorerSave(save)
    await expect(savedInput).toHaveBeenLastCalledWith(expect.objectContaining({
      model: "typesafe-ai/jev", modelType: "evaluation", provider: "vercel-ai-gateway",
      chainOfThought: false, imagePaths: [],
    }))
    await select("GPT-4.1 mini", /GPT-4.1 mini/)
    await expect(canvas.getByLabelText("Custom Image Path")).toBeVisible()
    await expect(canvas.getByRole("switch", { name: "Chain of thought" })).not.toBeChecked()
    await expect(canvas.queryByText(/without a written explanation/)).not.toBeInTheDocument()
  },
}

export const DirectOpenAIProvider: Story = {
  ...NewScorerEditor,
  parameters: {
    ...NewScorerEditor.parameters,
    msw: { handlers: [
      http.post("/api/scorers", async ({ request }) => {
        const input = await request.json() as Record<string, unknown>
        savedInput(input)
        return data({ ...input, id: "direct-openai-scorer", revision: 1 })
      }),
      ...datasetsEvalsHandlers,
    ] },
  },
  render: () => <DraftScorerHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    await userEvent.type(await canvas.findByLabelText("Name"), "Direct OpenAI evaluation")
    await userEvent.click(canvas.getByRole("combobox", { name: "Model" }))
    await userEvent.click(within(await page.findByRole("group", { name: "OpenAI" })).getByRole("option", { name: /GPT-4.1 mini/ }))
    await waitFor(() => expect(page.queryByRole("listbox")).not.toBeInTheDocument())
    await userEvent.click(canvas.getByRole("button", { name: "Reopen scorer" }))
    await expect(await canvas.findByRole("combobox", { name: "Model" })).toHaveTextContent("GPT-4.1 mini")
    await expect(canvas.getByRole("switch", { name: "Chain of thought" })).toBeVisible()
    const save = canvas.getByRole("button", { name: "Save" })
    await userEvent.click(save)
    await waitForScorerSave(save)
    await expect(savedInput).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "openai", model: "gpt-4.1-mini", modelType: "language" }))
  },
}

export const DirectTypeSafeProvider: Story = {
  ...NewScorerEditor,
  parameters: {
    ...NewScorerEditor.parameters,
    msw: {
      handlers: [
        http.post("/api/scorers", async ({ request }) => {
          const input = await request.json() as Record<string, unknown>
          savedInput(input)
          return data({ ...input, id: "direct-typesafe-scorer", revision: 1 })
        }),
        http.put("/api/scorers/direct-typesafe-scorer", async ({ request }) => {
          const input = await request.json() as Record<string, unknown>
          savedInput(input)
          return data({ ...input, id: "direct-typesafe-scorer", revision: Number(input.expectedRevision) + 1 })
        }),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  render: () => <DraftScorerHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    await userEvent.type(await canvas.findByLabelText("Name"), "Direct Jev evaluation")
    await userEvent.click(canvas.getByRole("switch", { name: "Chain of thought" }))
    await userEvent.type(canvas.getByLabelText("Custom Image Path"), "output.image.url")
    await expect(canvas.queryByRole("combobox", { name: "Provider" })).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("combobox", { name: "Model" }))
    const search = await page.findByRole("combobox", { name: "Search model" })
    await waitFor(() => expect(search).toHaveFocus())
    await userEvent.type(search, "Jev")
    await expect(page.getAllByRole("option", { name: /Jev/ })).toHaveLength(2)
    await expect(within(page.getByRole("group", { name: "Vercel AI Gateway" })).getByRole("option", { name: /Jev/ })).toBeVisible()
    await userEvent.click(within(page.getByRole("group", { name: "TypeSafe AI" })).getByRole("option", { name: /Jev/ }))
    await waitFor(() => expect(page.queryByRole("listbox")).not.toBeInTheDocument())
    await expect(canvas.getByRole("combobox", { name: "Model" })).toHaveTextContent("Jev")
    await expect(canvas.queryByRole("switch", { name: "Chain of thought" })).not.toBeInTheDocument()
    await expect(canvas.queryByLabelText("Custom Image Path")).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("button", { name: "Reopen scorer" }))
    await expect(await canvas.findByRole("combobox", { name: "Model" })).toHaveTextContent("typesafe-ai")
    await expect(canvas.getByRole("combobox", { name: "Model" })).toHaveTextContent("Jev")
    await expect(canvas.queryByRole("combobox", { name: "Provider" })).not.toBeInTheDocument()
    const save = canvas.getByRole("button", { name: "Save" })
    await userEvent.click(save)
    await waitForScorerSave(save)
    await expect(savedInput).toHaveBeenLastCalledWith(expect.objectContaining({
      provider: "typesafe-ai", model: "jev-latest", modelType: "evaluation", chainOfThought: false, imagePaths: [],
    }))
    await userEvent.click(canvas.getByRole("combobox", { name: "Model" }))
    await userEvent.click(await within(await page.findByRole("group", { name: "Vercel AI Gateway" })).findByRole("option", { name: /Jev/ }))
    await waitFor(() => expect(page.queryByRole("listbox")).not.toBeInTheDocument())
    await expect(canvas.getByRole("combobox", { name: "Model" })).toHaveTextContent("Jev")
    await expect(canvas.getByRole("combobox", { name: "Model" })).not.toHaveTextContent("vercel-ai-gateway")
    await userEvent.click(save)
    await waitForScorerSave(save)
    await expect(savedInput).toHaveBeenLastCalledWith(expect.objectContaining({
      provider: "vercel-ai-gateway", model: "typesafe-ai/jev", modelType: "evaluation",
    }))
  },
}

export const DirectTypeSafeDuringGatewayOutage: Story = {
  ...NewScorerEditor,
  parameters: {
    ...NewScorerEditor.parameters,
    msw: {
      handlers: [
        http.get("/api/projects/:projectId/providers/models", () => failure("Gateway catalog unavailable.", 503)),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    const trigger = canvas.getByRole("combobox", { name: "Model" })
    await expect(canvas.queryByRole("combobox", { name: "Provider" })).not.toBeInTheDocument()
    await userEvent.click(trigger)
    await expect(await page.findByText("Gateway catalog unavailable.")).toBeVisible()
    await expect(page.getByRole("button", { name: "Retry models" })).toBeEnabled()
    await userEvent.click(within(page.getByRole("group", { name: "TypeSafe AI" })).getByRole("option", { name: /Jev/ }))
    await waitFor(() => expect(page.queryByRole("listbox")).not.toBeInTheDocument())
    await expect(trigger).toHaveTextContent("Jev")
    await expect(trigger).toHaveTextContent("typesafe-ai")
  },
}

export const LocalDraftAndSaveShortcut: Story = {
  ...NewScorerEditor,
  render: () => <DraftScorerHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const key = `datool:scorer-draft:${storybookProject.organizationId}:${storybookProject.projectId}:new`
    getRouter().replace.mockClear()
    await expect(
      canvas.queryByRole("img", { name: "Unsaved draft" })
    ).not.toBeInTheDocument()
    await userEvent.type(
      await canvas.findByLabelText("Name"),
      "Local scorer draft"
    )
    await userEvent.click(canvas.getByRole("button", { name: "Javascript" }))
    await expect(
      canvas.getByRole("img", { name: "Unsaved draft" })
    ).toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "Save" })
    ).toHaveTextContent("")
    await expect(JSON.parse(localStorage.getItem(key)!).draft.name).toBe(
      "Local scorer draft"
    )
    await userEvent.click(canvas.getByRole("button", { name: "Reopen scorer" }))
    await expect(await canvas.findByLabelText("Name")).toHaveValue(
      "Local scorer draft"
    )
    await expect(
      canvas.getByRole("button", { name: "Javascript" })
    ).toHaveAttribute("aria-pressed", "true")
    await expect(
      canvas.getByRole("img", { name: "Unsaved draft" })
    ).toBeVisible()
    await userEvent.click(
      await canvas.findByRole("textbox", { name: "Scorer code" })
    )
    await userEvent.keyboard("{Meta>}s{/Meta}")
    await waitForScorerSave(canvas.getByRole("button", { name: "Save" }))
    await expect(getRouter().replace).not.toHaveBeenCalled()
    await expect(localStorage.getItem(key)).toBeNull()
    await expect(
      canvas.queryByRole("img", { name: "Unsaved draft" })
    ).not.toBeInTheDocument()
    await expect(canvas.getByRole("button", { name: "Save" })).toBeDisabled()
  },
}

export const FailedSaveKeepsLocalDraft: Story = {
  ...NewScorerEditor,
  parameters: {
    ...NewScorerEditor.parameters,
    msw: {
      handlers: [
        http.post("/api/scorers", () => failure("Unable to save scorer.", 503)),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  render: () => <DraftScorerHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      await canvas.findByLabelText("Name"),
      "Keep this draft"
    )
    await userEvent.click(canvas.getByRole("button", { name: "Javascript" }))
    await userEvent.click(canvas.getByRole("button", { name: "Save" }))
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Unable to save scorer."
    )
    await expect(
      canvas.getByRole("img", { name: "Unsaved draft" })
    ).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Reopen scorer" }))
    await expect(await canvas.findByLabelText("Name")).toHaveValue(
      "Keep this draft"
    )
    await expect(
      canvas.getByRole("img", { name: "Unsaved draft" })
    ).toBeVisible()
  },
}

const staySaveRequests = fn()
export const RepeatedSavesKeepEditor: Story = {
  ...NewScorerEditor,
  parameters: {
    ...NewScorerEditor.parameters,
    msw: {
      handlers: [
        http.post("/api/scorers", async ({ request }) => {
          const input = (await request.json()) as Record<string, unknown>
          staySaveRequests("create", input)
          await delay(100)
          return data({ ...input, id: "saved-in-place", revision: 1 })
        }),
        http.put("/api/scorers/saved-in-place", async ({ request }) => {
          const input = (await request.json()) as Record<string, unknown>
          staySaveRequests("update", input)
          await delay(100)
          return data({
            ...input,
            id: "saved-in-place",
            revision: Number(input.expectedRevision) + 1,
          })
        }),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    staySaveRequests.mockClear()
    getRouter().replace.mockClear()
    const canvas = within(canvasElement)
    await userEvent.type(await canvas.findByLabelText("Name"), "Save in place")
    await userEvent.click(canvas.getByRole("button", { name: "Javascript" }))
    await userEvent.click(canvas.getByRole("button", { name: "Run JSON 1" }))
    const result = await canvas.findByRole("status", {
      name: "Scorer test result",
    })
    const save = canvas.getByRole("button", { name: "Save" })
    await userEvent.click(save)
    await waitForScorerSave(save)
    await expect(window.location.pathname).toBe(`${scorersHref}/saved-in-place`)
    await expect(
      canvas.getByRole("status", { name: "Scorer test result" })
    ).toBe(result)
    for (const revision of [1, 2]) {
      await userEvent.type(canvas.getByLabelText("Name"), " updated")
      await userEvent.keyboard("{Meta>}s{/Meta}")
      await waitForScorerSave(save)
      await expect(staySaveRequests).toHaveBeenLastCalledWith(
        "update",
        expect.objectContaining({ expectedRevision: revision })
      )
    }
    await expect(staySaveRequests).toHaveBeenCalledTimes(3)
    await expect(getRouter().replace).not.toHaveBeenCalled()
    await expect(
      canvas.getByRole("status", { name: "Scorer test result" })
    ).toBe(result)
  },
}


export const LibraryScorerSettings: Story = {
  parameters: {
    ...detailParameters,
    msw: { handlers: [
      http.get("/api/scorers/:scorerId", () => data({
        ...scorerRows[0], ...libraryScorerPreset("ValidJSON"),
      })),
      ...datasetsEvalsHandlers,
    ] },
  },
  render: renderScorerDetail,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const schema = await canvas.findByRole("textbox", { name: "JSON Schema" })
    await expect(canvas.getByLabelText("Library output field")).toHaveValue("trace.output")
    await userEvent.type(schema, "invalid")
    await expect(canvas.getByRole("alert")).toHaveTextContent("Enter a JSON object")
    await expect(canvas.getByRole("button", { name: "Save" })).toBeDisabled()
    await userEvent.clear(schema)
    await userEvent.paste('{"type":"object"}')
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
    await expect(canvas.getByRole("button", { name: "Save" })).toBeEnabled()
  },
}

export const SelectionHeader: Story = {
  ...Catalog,
  play: async ({ canvasElement }) => checkCollectionSelection(canvasElement, "Scorers"),
}
