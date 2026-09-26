import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { http, delay } from "msw"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import {
  datasetsEvalsHandlers,
  data,
  failure,
} from "../../.storybook/scenarios/datasets-evals/handlers"
import {
  evaluators,
  list,
} from "../../.storybook/scenarios/datasets-evals/fixtures"
import { libraryScorerPreset } from "@/src/lib/tracer/scorers"
import type { LibraryEvaluatorId } from "@/src/lib/tracer/scorer-libraries"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { ScorerPicker } from "./scorer-picker"

const selectedLibrary = fn()
const saved = http.post("/api/scorers/libraries", async ({ request }) => {
  const { evaluator } = (await request.json()) as {
    evaluator: LibraryEvaluatorId
  }
  selectedLibrary(evaluator)
  const config = libraryScorerPreset(evaluator)
  return data({
    ...evaluators[0],
    id: `library-${evaluator}`,
    name: config.name,
    description: config.description,
    activeVersion: {
      ...evaluators[0].activeVersion,
      id: "library-version",
      evaluatorId: `library-${evaluator}`,
      config,
    },
  })
})
function Picker({
  maxSelected,
  disabled,
}: {
  maxSelected?: number
  disabled?: boolean
}) {
  const [value, setValue] = useState<string[]>([])
  return (
    <StorybookProjectFrame title="Scorers">
      <div className="max-w-xl p-4">
        <ScorerPicker
          value={value}
          onValueChange={setValue}
          maxSelected={maxSelected}
          disabled={disabled}
        />
        <output aria-label="Selected scorer IDs">{value.join(",")}</output>
      </div>
    </StorybookProjectFrame>
  )
}
const meta = {
  title: "Tracer/Scorers/ScorerPicker",
  component: ScorerPicker,
  args: { value: [], onValueChange: fn() },
  parameters: {
    layout: "fullscreen",
    msw: { handlers: [saved, ...datasetsEvalsHandlers] },
  },
  beforeEach: () => {
    selectedLibrary.mockClear()
  },
  render: (args) => (
    <Picker maxSelected={args.maxSelected} disabled={args.disabled} />
  ),
} satisfies Meta<typeof ScorerPicker>
export default meta
type Story = StoryObj<typeof meta>

async function open(canvasElement: HTMLElement) {
  const page = within(canvasElement.ownerDocument.body)
  await userEvent.click(
    await within(canvasElement).findByRole("combobox", { name: "Scorers" })
  )
  await page.findByRole("option", { name: /Exact match/ })
  return page
}
export const Groups: Story = {
  play: async ({ canvasElement }) => {
    const page = await open(canvasElement)
    await expect(await page.findByText("This project")).toBeVisible()
    await expect(page.getByText("AutoEvals", { exact: true })).toBeVisible()
    await expect(
      page.getByRole("option", { name: /Factuality/ })
    ).toHaveTextContent("openai/gpt-4.1-mini")
    await expect(page.queryByRole("dialog")).not.toBeInTheDocument()
  },
}
export const HoverDetails: Story = {
  play: async ({ canvasElement }) => {
    const page = await open(canvasElement)
    const projectOption = await page.findByRole("option", {
      name: new RegExp(evaluators[0].name),
    })
    await userEvent.hover(projectOption)
    const projectCard = await page.findByRole("region", {
      name: `${evaluators[0].name} details`,
    })
    await expect(projectCard).toHaveTextContent(evaluators[0].description!)
    await expect(projectCard).toHaveTextContent("Revision3")
    await expect(projectCard).toHaveTextContent("Score ≥ 0.8")
    await userEvent.hover(projectCard)
    await expect(projectCard).toBeVisible()
    await userEvent.hover(page.getByRole("option", { name: /Exact match/ }))
    const libraryCard = await page.findByRole("region", {
      name: "Exact match details",
    })
    await expect(libraryCard).toHaveTextContent("AutoEvals 0.3.0")
    await expect(libraryCard).toHaveTextContent("Output, Reference answer")
    await expect(libraryCard).toHaveTextContent(
      "Runs without a language model."
    )
    await expect(
      page.queryByRole("region", { name: `${evaluators[0].name} details` })
    ).not.toBeInTheDocument()
    await expect(selectedLibrary).not.toHaveBeenCalled()
    await userEvent.unhover(page.getByRole("option", { name: /Exact match/ }))
    await userEvent.type(
      page.getByRole("combobox", { name: "Scorers" }),
      "Factuality"
    )
    await userEvent.hover(page.getByRole("option", { name: /Factuality/ }))
    const modelCard = await page.findByRole("region", {
      name: "Factuality details",
    })
    await expect(modelCard).toHaveTextContent("openai/gpt-4.1-mini")
    await expect(modelCard).toHaveTextContent("Input, Output, Reference answer")
    await userEvent.keyboard("{Escape}")
    await waitFor(() =>
      expect(
        page.queryByRole("region", { name: "Factuality details" })
      ).not.toBeInTheDocument()
    )
    await expect(
      page.getByLabelText("Selected scorer IDs")
    ).toBeEmptyDOMElement()
  },
}
export const HoverInsideDialog: Story = {
  render: function Example() {
    const [value, setValue] = useState<string[]>([])
    return (
      <StorybookProjectFrame title="Scorers">
        <Dialog defaultOpen>
          <DialogContent className="overflow-visible" aria-describedby={undefined}>
            <DialogTitle>Evaluate traces</DialogTitle>
            <ScorerPicker value={value} onValueChange={setValue} />
          </DialogContent>
        </Dialog>
      </StorybookProjectFrame>
    )
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    const dialog = await page.findByRole("dialog")
    await userEvent.click(
      within(dialog).getByRole("combobox", { name: "Scorers" })
    )
    const option = await page.findByRole("option", { name: /Valid JSON/ })
    await userEvent.hover(option)
    const card = await within(dialog).findByRole("region", {
      name: "Valid JSON details",
    })
    await userEvent.hover(card)
    await expect(card).toBeVisible()
    await userEvent.click(option)
    await expect(
      await page.findByRole("button", { name: "Remove Valid JSON" })
    ).toBeVisible()
    await expect(dialog).toBeVisible()
    await expect(selectedLibrary).toHaveBeenCalledTimes(1)
  },
}
export const SelectBothGroups: Story = {
  play: async ({ canvasElement }) => {
    const page = await open(canvasElement)
    await userEvent.click(
      await page.findByRole("option", { name: new RegExp(evaluators[0].name) })
    )
    await userEvent.click(page.getByRole("option", { name: /Exact match/ }))
    await waitFor(() =>
      expect(page.getByLabelText("Selected scorer IDs")).toHaveTextContent(
        `${evaluators[0].id},library-ExactMatch`
      )
    )
    await expect(page.queryByRole("dialog")).not.toBeInTheDocument()
    await expect(selectedLibrary).toHaveBeenCalledTimes(1)
    await userEvent.keyboard("{Escape}")
    await userEvent.click(
      page.getByRole("button", { name: "Remove Exact match" })
    )
    await userEvent.click(page.getByRole("combobox", { name: "Scorers" }))
    await userEvent.click(
      await page.findByRole("option", { name: /Exact match/ })
    )
    await expect(selectedLibrary).toHaveBeenCalledTimes(1)
    await expect(page.getByLabelText("Selected scorer IDs")).toHaveTextContent(
      "library-ExactMatch"
    )
  },
}
export const SearchAndKeyboard: Story = {
  play: async ({ canvasElement }) => {
    const page = await open(canvasElement)
    const input = page.getByRole("combobox", { name: "Scorers" })
    await userEvent.type(input, "Levenshtein")
    await expect(page.getAllByRole("option")).toHaveLength(1)
    await expect(page.getByRole("option")).toHaveTextContent("Text similarity")
    await userEvent.keyboard("{ArrowDown}{Enter}")
    await waitFor(() =>
      expect(page.getByLabelText("Selected scorer IDs")).toHaveTextContent(
        "library-Levenshtein"
      )
    )
    await userEvent.keyboard("{Escape}")
    await expect(page.getByLabelText("Selected scorer IDs")).toHaveTextContent(
      "library-Levenshtein"
    )
  },
}
export const Maximum: Story = {
  args: { maxSelected: 1 },
  play: async ({ canvasElement }) => {
    const page = await open(canvasElement)
    await userEvent.click(
      await page.findByRole("option", { name: new RegExp(evaluators[0].name) })
    )
    await expect(
      page.getByRole("option", { name: /Exact match/ })
    ).toHaveAttribute("aria-disabled", "true")
    await expect(selectedLibrary).not.toHaveBeenCalled()
  },
}
export const SelectionFailure: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post("/api/scorers/libraries", () =>
          failure("Unable to select scorer.")
        ),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const page = await open(canvasElement)
    await userEvent.click(
      await page.findByRole("option", { name: new RegExp(evaluators[0].name) })
    )
    await userEvent.click(page.getByRole("option", { name: /Exact match/ }))
    await expect(await page.findByRole("alert")).toHaveTextContent(
      "Unable to select scorer."
    )
    await expect(page.getByLabelText("Selected scorer IDs")).toHaveTextContent(
      evaluators[0].id
    )
    await expect(
      page.getByLabelText("Selected scorer IDs")
    ).not.toHaveTextContent("library-")
    await expect(page.queryByRole("dialog")).not.toBeInTheDocument()
  },
}
export const EmptyProject: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/evaluators", () => data(list([]))),
        saved,
        ...datasetsEvalsHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const page = await open(canvasElement)
    await userEvent.click(page.getByRole("option", { name: /Valid JSON/ }))
    await waitFor(() =>
      expect(page.getByLabelText("Selected scorer IDs")).toHaveTextContent(
        "library-ValidJSON"
      )
    )
  },
}
export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/evaluators", async () => {
          await delay("infinite")
        }),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const page = await open(canvasElement)
    await expect(
      page.getByText("Loading scorers", { exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole("option", { name: /Exact match/ })
    ).toBeVisible()
  },
}
export const CatalogFailure: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/evaluators", () => failure("Unable to load scorers.")),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const page = await open(canvasElement)
    await expect(
      await page.findByRole("button", { name: "Retry" })
    ).toBeVisible()
    await expect(
      page.getByRole("option", { name: /Exact match/ })
    ).toBeVisible()
  },
}
export const Disabled: Story = {
  args: { disabled: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("combobox", { name: "Scorers" })
    ).toBeDisabled()
  },
}
