import { checkCollectionSelection, checkCollectionPanel, checkCompactCollectionPanel } from "../../.storybook/collection-panel-checks"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { delay, http, HttpResponse } from "msw"
import { expect, userEvent, within, waitFor } from "storybook/test"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import { envelope } from "../../.storybook/scenarios/traces/fixtures"
import {
  humanScoreInputSchema,
  humanScoreCollectionInputSchema,
  type HumanScore,
  type HumanScoreCollection,
} from "@/src/lib/tracer/human-scores"
import { HumanScoresPage } from "./human-scores-page"

const fields = {
  revision: 1,
  archived: false,
  createdAt: "2026-09-13T12:00:00Z",
  updatedAt: "2026-09-13T12:00:00Z",
}
let scores: HumanScore[] = []
let collections: HumanScoreCollection[] = []
function reset() {
  scores = [
    {
      ...fields,
      id: "accuracy",
      name: "Accuracy",
      description: "Compare the answer with captured evidence.",
      type: "numeric",
      min: 0,
      max: 1,
      step: 0.01,
    },
  ]
  collections = []
}
const handlers = [
  http.get("/api/human-scores", () =>
    HttpResponse.json(envelope({ scores, collections }))
  ),
  http.post("/api/human-scores", async ({ request }) => {
    const score = {
      ...humanScoreInputSchema.parse(await request.json()),
      ...fields,
      id: crypto.randomUUID(),
    }
    scores.push(score)
    return HttpResponse.json(envelope(score))
  }),
  http.patch("/api/human-scores/:id", async ({ request, params }) => {
    const input = (await request.json()) as {
      expectedRevision: number
      score: unknown
    }
    const existing = scores.find((score) => score.id === params.id)!
    expect(input.expectedRevision).toBe(existing.revision)
    const updated = {
      ...existing,
      ...humanScoreInputSchema.parse(input.score),
      revision: existing.revision + 1,
    }
    scores = scores.map((score) => (score.id === updated.id ? updated : score))
    return HttpResponse.json(envelope(updated))
  }),
  http.post("/api/human-score-collections", async ({ request }) => {
    const collection = {
      ...humanScoreCollectionInputSchema.parse(await request.json()),
      ...fields,
      id: crypto.randomUUID(),
    }
    collections.push(collection)
    return HttpResponse.json(
      envelope({
        ...collection,
        scores: scores.filter((score) =>
          collection.scoreIds.includes(score.id)
        ),
      })
    )
  }),
]
const meta = {
  title: "Tracer/HumanScoresPage",
  component: HumanScoresPage,
  beforeEach: reset,
  parameters: { layout: "fullscreen", msw: { handlers } },
  render: () => (
    <StorybookProjectFrame title="Human Scores">
      <HumanScoresPage />
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof HumanScoresPage>
export default meta
type Story = StoryObj<typeof meta>
export const Library: Story = {
  play: async ({ canvasElement }) => {
    await checkCollectionPanel(canvasElement, "Human Scores")
    await expect(
      within(canvasElement).findByRole("button", { name: "Accuracy" })
    ).resolves.toBeVisible()
  },
}
export const PageHeaderTabs: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const header = canvas.getByRole("banner", { name: "Page controls" })
    const tabs = within(header).getByRole("tablist", { name: "Human Score library" })
    const scoresTab = within(tabs).getByRole("tab", { name: "Human Scores" })
    const collectionsTab = within(tabs).getByRole("tab", { name: "Collections" })
    await expect(scoresTab).toHaveAttribute("aria-selected", "true")
    await expect(canvas.getByRole("tabpanel", { name: "Human Scores" })).toBeVisible()
    await expect(scoresTab.getBoundingClientRect().bottom).toBeCloseTo(header.getBoundingClientRect().bottom, 0)
    scoresTab.focus()
    await userEvent.keyboard("{ArrowRight}")
    await expect(collectionsTab).toHaveFocus()
    await expect(collectionsTab).toHaveAttribute("aria-selected", "true")
    await expect(canvas.findByRole("heading", { name: "No collections yet" })).resolves.toBeVisible()
    await expect(canvas.getByRole("tabpanel", { name: "Collections" })).toBeVisible()
    await expect(canvas.getByRole("button", { name: "New collection" })).toBeVisible()
    await userEvent.keyboard("{ArrowLeft}")
    await expect(scoresTab).toHaveFocus()
    await expect(canvas.findByRole("button", { name: "Accuracy" })).resolves.toBeVisible()
    await expect(canvas.getAllByRole("button", { name: "Display" })).toHaveLength(1)
  },
}
export const CreateEnum: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      body = within(document.body)
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "New Human Score" })
      ).toBeEnabled()
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "New Human Score" })
    )
    const dialog = within(await body.findByRole("dialog"))
    await userEvent.type(dialog.getByLabelText("Name"), "Location match")
    await userEvent.click(dialog.getByRole("radio", { name: "Single choice" }))
    await userEvent.type(
      dialog.getByRole("textbox", { name: "Option 1" }),
      "Correct"
    )
    await userEvent.type(
      dialog.getByRole("textbox", { name: "Option 2" }),
      "Wrong location"
    )
    await userEvent.click(dialog.getByRole("button", { name: "Add option" }))
    await userEvent.type(
      dialog.getByRole("textbox", { name: "Option 3" }),
      "Clarified ambiguity"
    )
    await userEvent.click(
      dialog.getByRole("button", { name: "Create Human Score" })
    )
    await expect(
      canvas.findByRole("button", { name: "Location match" })
    ).resolves.toBeVisible()
    const saved = scores.find((score) => score.name === "Location match")!
    expect(saved.type).toBe("categorical")
    await userEvent.click(
      canvas.getByRole("button", { name: "Location match" })
    )
    const edit = within(await body.findByRole("dialog"))
    await userEvent.click(edit.getByRole("radio", { name: "Multiple choice" }))
    await userEvent.click(edit.getByRole("button", { name: "Save changes" }))
    await expect(canvas.findByText("Multiple choice")).resolves.toBeVisible()
    const updated = scores.find((score) => score.name === "Location match")!
    expect(updated.type === "categorical" && updated.multiple).toBe(true)
    if (saved.type === "categorical" && updated.type === "categorical")
      expect(updated.options).toEqual(saved.options)
  },
}
export const CreateCollection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement),
      body = within(document.body)
    await expect(
      canvas.findByRole("button", { name: "Accuracy" })
    ).resolves.toBeVisible()
    await userEvent.click(canvas.getByRole("tab", { name: "Collections" }))
    await expect(canvas.findByText("No collections yet")).resolves.toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: "New collection" })
    )
    const dialog = within(await body.findByRole("dialog"))
    await userEvent.type(dialog.getByLabelText("Name"), "Weather review")
    await userEvent.click(
      dialog.getByRole("combobox", { name: "Human Scores" })
    )
    await userEvent.click(
      await body.findByRole("option", { name: "Accuracy Numeric" })
    )
    await userEvent.keyboard("{Escape}")
    await userEvent.click(
      dialog.getByRole("button", { name: "Create collection" })
    )
    await expect(
      canvas.findByRole("button", { name: "Weather review" })
    ).resolves.toBeVisible()
    expect(collections[0].scoreIds).toEqual(["accuracy"])
  },
}
export const Empty: Story = {
  beforeEach: () => {
    reset()
    scores = []
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("No Human Scores yet")
    ).resolves.toBeVisible()
  },
}
export const Error: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/human-scores", () =>
          HttpResponse.json(
            { error: { message: "Could not load Human Scores" } },
            { status: 503 }
          )
        ),
        ...handlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("Could not load Human Scores")
    ).resolves.toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "New Human Score" })
    ).toBeDisabled()
  },
}

export const Loading: Story = {
  parameters: { msw: { handlers: [http.get("/api/human-scores", async () => { await delay("infinite") }), ...handlers] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("Loading Human Scores")).resolves.toBeVisible()
    await expect(canvas.getByRole("tab", { name: "Human Scores" })).toHaveAttribute("aria-selected", "true")
    await userEvent.click(canvas.getByRole("tab", { name: "Collections" }))
    await expect(canvas.getByRole("tabpanel", { name: "Collections" })).toBeVisible()
    await expect(canvas.getByRole("button", { name: "New collection" })).toBeDisabled()
  },
}

export const NarrowCollection: Story = {
  parameters: Library.parameters,
  render: () => <div className="w-[375px] max-w-full"><StorybookProjectFrame title="Human Scores"><HumanScoresPage /></StorybookProjectFrame></div>,
  play: async ({ canvasElement }) => {
    await checkCompactCollectionPanel(canvasElement, "Human Scores")
    const header = within(canvasElement).getByRole("banner", { name: "Page controls" })
    await expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth)
    await expect(within(header).getByRole("tab", { name: "Collections" })).toBeVisible()
  },
}

export const SelectionHeader: Story = {
  ...Library,
  play: async ({ canvasElement }) => checkCollectionSelection(canvasElement, "Human Scores"),
}

export const NarrowSelectionHeader: Story = {
  ...NarrowCollection,
  play: async ({ canvasElement }) => checkCollectionSelection(canvasElement, "Human Scores"),
}

export const CollectionSelectionHeader: Story = {
  beforeEach: () => {
    reset()
    collections.push({ ...fields, id: "collection", name: "Review quality", description: "", scoreIds: [scores[0].id] })
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole("checkbox", { name: "Select Accuracy" }))
    await expect(canvas.getByRole("button", { name: "Clear selection (1 selected)" })).toBeVisible()
    await userEvent.click(canvas.getByRole("tab", { name: "Collections" }))
    await expect(canvas.queryByRole("button", { name: /Clear selection/ })).not.toBeInTheDocument()
    await checkCollectionSelection(canvasElement, "Human Scores")
  },
}
