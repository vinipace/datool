import {
  checkCollectionSelection,
  checkCollectionPanel,
  checkCompactCollectionPanel,
} from "../../.storybook/collection-panel-checks"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { useState } from "react"
import { getRouter } from "@storybook/nextjs-vite/navigation.mock"
import { evalComparisonUrl } from "@/src/lib/tracer/eval-comparison"
import { Button } from "@/components/ui/button"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { http } from "msw"
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
  evalRunSummaries,
  list,
} from "../../.storybook/scenarios/datasets-evals/fixtures"
import type { EvalRunSummary } from "@/src/lib/tracer/contracts"
import { EvalsPage } from "./evals-page"

const displayKey = `datool:table:${storybookProject.organizationId}:${storybookProject.projectId}:eval-runs`

const meta = {
  title: "Tracer/Evals/EvalsPage",
  component: EvalsPage,
  beforeEach: () => {
    localStorage.removeItem(displayKey)
    localStorage.removeItem(`${displayKey}:columns`)
  },
  parameters: {
    layout: "fullscreen",
    nextjs: { navigation: { pathname: "/p/demo/evals" } },
  },
  render: () => (
    <StorybookProjectFrame title="Evaluation runs">
      <EvalsPage />
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof EvalsPage>

export default meta
type Story = StoryObj<typeof meta>

export const Runs: Story = {
  parameters: { msw: { handlers: datasetsEvalsHandlers } },
  play: async ({ canvasElement }) => {
    await checkCollectionPanel(canvasElement, "Evals")
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("Invoice assistant · billing FAQ baseline")
    ).resolves.toBeVisible()
    await userEvent.click(
      canvas.getByRole("checkbox", {
        name: "Select eval run 1: Invoice assistant · billing FAQ baseline",
      })
    )
    await expect(
      canvas.getByRole("button", { name: "Compare (1)" })
    ).toBeDisabled()
    await userEvent.click(
      canvas.getByRole("checkbox", {
        name: "Select eval run 2: Invoice assistant · billing FAQ candidate",
      })
    )
    await expect(
      canvas.getByRole("button", { name: "Compare (2)" })
    ).toBeEnabled()
    await userEvent.click(canvas.getByRole("button", { name: "Compare (2)" }))
    await expect(getRouter().push).toHaveBeenLastCalledWith(
      evalComparisonUrl(evalRunSummaries.slice(0, 2).map((run) => run.id))
    )
  },
}

function RemountableEvals() {
  const [mount, setMount] = useState(0)
  return (
    <StorybookProjectFrame title="Evaluation runs">
      <Button onClick={() => setMount((value) => value + 1)}>
        Remount eval runs
      </Button>
      <EvalsPage key={mount} />
    </StorybookProjectFrame>
  )
}

export const PersistentDisplay: Story = {
  parameters: Runs.parameters,
  render: () => <RemountableEvals />,
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
      body.getByRole("menuitemcheckbox", { name: "Metadata" })
    )
    await userEvent.click(body.getByRole("menuitemradio", { name: "Tall" }))
    const resize = canvas.getByRole("separator", { name: "Resize run" })
    resize.focus()
    await userEvent.keyboard("{ArrowRight}")
    await userEvent.click(
      canvas.getByRole("button", { name: "Remount eval runs" })
    )
    await display()
    await expect(
      body.getByRole("menuitemradio", { name: "Tall" })
    ).toHaveAttribute("aria-checked", "true")
    await expect(
      body.getByRole("menuitemcheckbox", { name: "Metadata" })
    ).toHaveAttribute("aria-checked", "false")
    await userEvent.click(body.getByRole("menuitemradio", { name: "Card" }))
    await userEvent.click(
      canvas.getByRole("button", { name: "Remount eval runs" })
    )
    await expect(
      canvas.findByLabelText("Collection cards scroll area")
    ).resolves.toBeVisible()
    await expect(
      canvas.queryByRole("term", { name: "Metadata" })
    ).not.toBeInTheDocument()
    await display()
    await userEvent.click(body.getByRole("menuitemradio", { name: "Compact" }))
    await expect(
      canvas.getByRole("separator", { name: "Resize run" })
    ).toHaveAttribute("aria-valuenow", "296")
    await waitFor(() =>
      expect(
        canvas
          .getByRole("checkbox", { name: /Select eval run 1/ })
          .closest("tr")!
          .getBoundingClientRect().height
      ).toBe(40)
    )
  },
}

export const Empty: Story = {
  parameters: {
    msw: { handlers: [http.get("/api/evals", () => data(list([])))] },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("No eval runs yet.")
    ).resolves.toBeVisible()
  },
}

export const LoadFailure: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/evals", () => failure("Could not load eval runs")),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("alert")
    ).resolves.toHaveTextContent("Could not load eval runs")
  },
}

export const NarrowCollection: Story = {
  parameters: Runs.parameters,
  render: () => (
    <div className="w-[375px] max-w-full">
      <StorybookProjectFrame title="Evals">
        <EvalsPage />
      </StorybookProjectFrame>
    </div>
  ),
  play: async ({ canvasElement }) => {
    await checkCompactCollectionPanel(canvasElement, "Evals")
  },
}

let finishLoading: (() => void) | undefined

export const LoadingTransition: Story = {
  beforeEach: () => {
    finishLoading = undefined
  },
  parameters: {
    msw: {
      handlers: [
        http.get(
          "/api/evals",
          () =>
            new Promise<Response>((resolve) => {
              finishLoading = () => resolve(data(list(evalRunSummaries)))
            })
        ),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Loading eval runs")
    await waitFor(() => expect(typeof finishLoading).toBe("function"))
    const toolbar = canvas.getByRole("group", { name: "Evals controls" })
    const search = toolbar.querySelector('[data-slot="filter-bar"]')!
    const display = toolbar.querySelector(
      '[data-slot="collection-display-skeleton"]'
    )!
    await expect(
      canvas.queryByRole("button", { name: /Compare/ })
    ).not.toBeInTheDocument()
    const before = {
      toolbar: toolbar.getBoundingClientRect(),
      search: search.getBoundingClientRect(),
      display: display.getBoundingClientRect(),
    }
    // Sample each painted frame, including the frame in which the table mounts.
    const frames: { toolbar: number; search: number }[] = []
    let active = true
    const sample = () => {
      if (!active) return
      frames.push({
        toolbar: toolbar.getBoundingClientRect().height,
        search: search.getBoundingClientRect().width,
      })
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
    try {
      finishLoading!()
      await canvas.findByText("Invoice assistant · billing FAQ baseline")
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
      await expect(
        canvas.queryByRole("button", { name: /Compare/ })
      ).not.toBeInTheDocument()
      await expect(toolbar.getBoundingClientRect().height).toBe(
        before.toolbar.height
      )
      await expect(search.getBoundingClientRect().width).toBeCloseTo(
        before.search.width,
        1
      )
      await expect(
        canvas.getByRole("button", { name: "Display" }).getBoundingClientRect()
          .width
      ).toBeCloseTo(before.display.width, 1)
      for (const frame of frames) {
        await expect(frame.toolbar).toBe(before.toolbar.height)
        await expect(frame.search).toBeCloseTo(before.search.width, 1)
      }
    } finally {
      active = false
    }
  },
}

export const NarrowLoadingTransition: Story = {
  ...LoadingTransition,
  render: NarrowCollection.render,
}

export const Loading: Story = {
  ...LoadingTransition,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("Loading eval runs")).resolves.toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: /Compare/ })
    ).not.toBeInTheDocument()
  },
}

export const SelectionHeader: Story = {
  ...Runs,
  play: async ({ canvasElement }) =>
    checkCollectionSelection(canvasElement, "Evals"),
}

export const NarrowSelectionHeader: Story = {
  ...NarrowCollection,
  play: async ({ canvasElement }) =>
    checkCollectionSelection(canvasElement, "Evals"),
}

export const CardSelectionHeader: Story = {
  ...Runs,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("checkbox", { name: /Select eval run 1/ })
    await userEvent.click(canvas.getByRole("button", { name: "Display" }))
    await userEvent.click(
      within(document.body).getByRole("menuitemradio", { name: "Card" })
    )
    await expect(canvas.getByLabelText("Collection cards scroll area")).toBeVisible()
    await checkCollectionSelection(canvasElement, "Evals")
  },
}

const mixedMembershipRun: EvalRunSummary = {
  ...evalRunSummaries[0],
  name: "Mixed workflows",
  groupsResolvedAt: "2026-09-19T12:00:00Z",
  groups: [
    { type: "workflow", name: "Answer" },
    { type: "workflow", name: "Extract" },
    { type: "agent", name: "Writer" },
  ],
}
const groupedParameters = {
  nextjs: {
    navigation: { pathname: "/p/demo/evals", query: { groupBy: "workflow" } },
  },
  msw: {
    handlers: [
      http.get("/api/evals/groups", () =>
        data(
          list([
            {
              id: "answer",
              type: "workflow",
              name: "Answer",
              state: "assigned",
              runCount: 1,
              filter: 'workflow = "Answer"',
            },
            {
              id: "extract",
              type: "workflow",
              name: "Extract",
              state: "assigned",
              runCount: 101,
              filter: 'workflow = "Extract"',
            },
            {
              id: "legacy",
              type: "workflow",
              name: null,
              state: "unresolved",
              runCount: 1,
              filter: "workflow = null groupsResolvedAt = null",
            },
          ])
        )
      ),
      http.get("/api/evals", ({ request }) =>
        data(
          list(
            new URL(request.url).searchParams
              .get("filter")
              ?.includes("groupsResolvedAt")
              ? [
                  {
                    ...evalRunSummaries[1],
                    name: "Legacy run",
                    groups: [],
                    groupsResolvedAt: null,
                  },
                ]
              : [mixedMembershipRun]
          )
        )
      ),
      ...datasetsEvalsHandlers,
    ],
  },
}

export const SavedMemberships: Story = {
  parameters: groupedParameters,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await expect(
      canvas.findByRole("button", { name: "Answer 1 run" })
    ).resolves.toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "Not resolved 1 run" })
    ).toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: "Extract 101 runs" })
    )
    await waitFor(() =>
      expect(
        canvas.getAllByRole("checkbox", {
          name: /Select eval run 1: Mixed workflows/,
        })
      ).toHaveLength(2)
    )
    const copies = canvas.getAllByRole("checkbox", {
      name: /Select eval run 1: Mixed workflows/,
    })
    await userEvent.click(copies[0])
    await expect(copies[1]).toBeChecked()
    const controls = within(canvas.getByRole("group", { name: "Evals controls" }))
    await expect(controls.getByRole("button", { name: "Clear selection (1 selected)" })).toBeVisible()
    await expect(controls.queryByRole("button", { name: "Display" })).not.toBeInTheDocument()
    await expect(
      controls.getByRole("button", { name: "Compare (1)" })
    ).toBeDisabled()
    const more = canvas.getAllByRole("button", {
      name: "Show all 3 operations",
    })[0]
    more.focus()
    await userEvent.keyboard("{Enter}")
    const popup = await body.findByRole("dialog", {
      name: "Operations",
    })
    await expect(
      within(popup).getByRole("link", { name: "workflow Answer" })
    ).toHaveAttribute("href", expect.stringContaining("workflows?filter="))
    await expect(
      within(popup).getByRole("link", { name: "workflow Extract" })
    ).toBeVisible()
    await userEvent.keyboard("{Escape}")
    await expect(more).toHaveFocus()
    await userEvent.click(copies[0])
    await userEvent.click(canvas.getByRole("button", { name: "Display" }))
    await userEvent.click(
      body.getByRole("menuitem", { name: "Group by Workflow" })
    )
    const originalUrl = window.location.href
    try {
      await userEvent.click(body.getByRole("menuitemradio", { name: "Agent" }))
      await expect(
        new URL(window.location.href).searchParams.get("groupBy")
      ).toBe("agent")
    } finally {
      window.history.replaceState(null, "", originalUrl)
    }
  },
}

export const NarrowSavedMemberships: Story = {
  ...SavedMemberships,
  render: NarrowCollection.render,
}

export const GroupedEmpty: Story = {
  parameters: {
    ...groupedParameters,
    msw: { handlers: [http.get("/api/evals/groups", () => data(list([])))] },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("No eval runs yet.")
    ).resolves.toBeVisible()
    await expect(
      within(canvasElement).getByRole("button", { name: "Display" })
    ).toBeVisible()
  },
}

export const GroupedFailure: Story = {
  parameters: {
    ...groupedParameters,
    msw: {
      handlers: [
        http.get("/api/evals/groups", () => failure("Could not load groups")),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("Could not load groups")
    ).resolves.toBeVisible()
    await expect(
      within(canvasElement).getByRole("button", { name: "Retry" })
    ).toBeVisible()
  },
}

export const GroupedLoading: Story = {
  parameters: {
    ...groupedParameters,
    msw: {
      handlers: [
        http.get("/api/evals/groups", async () => {
          await new Promise((resolve) => setTimeout(resolve, 2000))
          return data(list([]))
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("Loading eval groups")
    ).resolves.toBeVisible()
  },
}
