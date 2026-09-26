import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import {
  gatewayModels,
  modelProviderHandlers,
} from "../../.storybook/scenarios/model-providers"
import { ModelCombobox } from "./model-combobox"
import {
  GATEWAY_PROVIDER,
  TYPESAFE_PROVIDER,
  typeSafeModels,
  projectModels,
} from "@/src/lib/model-providers"

function Controlled(props: Parameters<typeof ModelCombobox>[0]) {
  const [value, setValue] = useState(props.value)
  return (
    <div className="w-80 max-w-full">
      <ModelCombobox
        {...props}
        value={value}
        onValueChange={(id) => {
          setValue(id)
          props.onValueChange(id)
        }}
      />
    </div>
  )
}
const changed = fn()
const retry = fn()
const meta = {
  title: "UI/ModelCombobox",
  component: ModelCombobox,
  parameters: { msw: { handlers: modelProviderHandlers } },
  args: { models: gatewayModels, value: "", onValueChange: changed },
  beforeEach: () => {
    changed.mockClear()
    retry.mockClear()
  },
  render: (args) => <Controlled {...args} />,
} satisfies Meta<typeof ModelCombobox>
export default meta
type Story = StoryObj<typeof meta>

export const SearchAndKeyboard: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    const trigger = canvas.getByRole("combobox", { name: "Model" })
    await userEvent.click(trigger)
    const search = await page.findByRole("combobox", {
      name: "Search model",
    })
    await userEvent.type(search, "openai")
    await expect(
      page.getByRole("option", { name: /GPT-4.1 mini/ })
    ).toBeVisible()
    await expect(
      page.queryByRole("option", { name: /embedding/ })
    ).not.toBeInTheDocument()
    await userEvent.clear(search)
    await userEvent.type(search, "Jev")
    await expect(
      page.queryByRole("option", { name: /Jev/ })
    ).not.toBeInTheDocument()
    await userEvent.clear(search)
    await userEvent.type(search, "openai")
    await userEvent.keyboard("{ArrowDown}{Enter}")
    await expect(trigger).toHaveTextContent("GPT-4.1 mini")
    await expect(changed).toHaveBeenLastCalledWith("openai/gpt-4.1-mini")
    await waitFor(() =>
      expect(page.queryByRole("listbox")).not.toBeInTheDocument()
    )
    await userEvent.click(trigger)
    await waitFor(() =>
      expect(page.getByRole("combobox", { name: "Search model" })).toHaveFocus()
    )
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(trigger).toHaveFocus())
  },
}
export const Loading: Story = { args: { models: [], loading: true } }

export const OpenAIAndGateway: Story = {
  args: { models: projectModels(gatewayModels) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    const trigger = canvas.getByRole("combobox", { name: "Model" })
    await userEvent.click(trigger)
    const search = await page.findByRole("combobox", { name: "Search model" })
    await userEvent.type(search, "GPT-4.1")
    await expect(
      page.getAllByRole("option", { name: /GPT-4.1 mini/ })
    ).toHaveLength(2)
    const direct = within(
      page.getByRole("group", { name: "OpenAI" })
    ).getByRole("option", { name: /GPT-4.1 mini/ })
    await userEvent.hover(direct)
    const details = await page.findByRole("region", { name: "Model details" })
    await expect(
      within(details).getByText("$0.40 / million tokens")
    ).toBeVisible()
    await expect(within(details).getByText("1,047,576 tokens")).toBeVisible()
    await userEvent.click(direct)
    await expect(changed).toHaveBeenLastCalledWith("openai/gpt-4.1-mini")
    await waitFor(() =>
      expect(page.queryByRole("listbox")).not.toBeInTheDocument()
    )
    await userEvent.click(trigger)
    await userEvent.click(
      within(
        await page.findByRole("group", { name: "Vercel AI Gateway" })
      ).getByRole("option", { name: /GPT-4.1 mini/ })
    )
    await expect(changed).toHaveBeenLastCalledWith(
      "vercel-ai-gateway/openai/gpt-4.1-mini"
    )
  },
}

export const GroupedProviders: Story = {
  args: {
    modelType: ["language", "evaluation"],
    models: [
      ...gatewayModels.map((model) => ({
        ...model,
        provider: GATEWAY_PROVIDER,
      })),
      ...typeSafeModels.map((model) => ({
        ...model,
        provider: TYPESAFE_PROVIDER,
      })),
      ...Array.from({ length: 400 }, (_, index) => ({
        id: `openai/test-${index}`,
        name: `Test model ${index}`,
        creator: "openai",
        provider: GATEWAY_PROVIDER,
        type: "language",
        tags: [],
      })),
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    const trigger = canvas.getByRole("combobox", { name: "Model" })
    await userEvent.click(trigger)
    await page.findByRole("group", { name: "Vercel AI Gateway" })
    await expect(page.getAllByRole("option").length).toBeLessThan(50)
    const search = page.getByRole("combobox", { name: "Search model" })
    await waitFor(() => expect(search).toHaveFocus())
    await userEvent.type(search, "Jev")
    await expect(page.getAllByRole("option", { name: /Jev/ })).toHaveLength(2)
    for (const provider of ["Vercel AI Gateway", "TypeSafe AI"]) {
      const option = within(
        page.getByRole("group", { name: provider })
      ).getByRole("option", { name: /Jev/ })
      await expect(within(option).getByText("typesafe-ai")).toBeVisible()
      await expect(option).not.toHaveTextContent("/*")
    }
    // Group headings are not selectable; keyboard navigation crosses the boundary.
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}")
    await expect(changed).toHaveBeenLastCalledWith("typesafe-ai/jev-latest")
    await expect(trigger).toHaveTextContent("Jev")
    await expect(trigger).not.toHaveTextContent("/*")
    await waitFor(() =>
      expect(page.queryByRole("listbox")).not.toBeInTheDocument()
    )
    await userEvent.click(trigger)
    const reopened = await page.findByRole("combobox", { name: "Search model" })
    await waitFor(() => expect(reopened).toHaveFocus())
    await userEvent.type(reopened, "Jev")
    await expect(
      within(page.getByRole("group", { name: "TypeSafe AI" })).getByRole(
        "option",
        { name: /Jev/, selected: true }
      )
    ).toBeVisible()
    await userEvent.click(
      within(page.getByRole("group", { name: "Vercel AI Gateway" })).getByRole(
        "option",
        { name: /Jev/ }
      )
    )
    await expect(changed).toHaveBeenLastCalledWith(
      "vercel-ai-gateway/typesafe-ai/jev"
    )
    await waitFor(() =>
      expect(page.queryByRole("listbox")).not.toBeInTheDocument()
    )
    await userEvent.click(trigger)
    const filtered = await page.findByRole("combobox", { name: "Search model" })
    await waitFor(() => expect(filtered).toHaveFocus())
    await userEvent.type(filtered, "Claude")
    await expect(
      page.queryByRole("group", { name: "TypeSafe AI" })
    ).not.toBeInTheDocument()
    await userEvent.clear(filtered)
    await userEvent.type(filtered, "no model matches")
    await expect(page.getByText("No options found.")).toBeVisible()
    await expect(page.queryByRole("group")).not.toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(trigger).toHaveFocus())
  },
}

export const RelativePricePies: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole("combobox", { name: "Model" }))
    const expensive = await page.findByRole("option", { name: /Claude Sonnet/ })
    const pie = within(expensive).getByRole("img", {
      name: "Expensive model price",
    })
    await expect(pie.getBoundingClientRect().width).toBe(20)
    await expect(pie.getBoundingClientRect().height).toBe(20)
    await userEvent.type(
      page.getByRole("combobox", { name: "Search model" }),
      "Claude"
    )
    await expect(
      page.getByRole("img", { name: "Expensive model price" })
    ).toBeVisible()
    await userEvent.click(page.getByRole("option", { name: /Claude Sonnet/ }))
    await expect(
      within(canvas.getByRole("combobox", { name: "Model" })).getByRole("img", {
        name: "Expensive model price",
      })
    ).toBeVisible()
  },
}
export const SharedModelDetails: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole("combobox", { name: "Model" }))
    const first = await page.findByRole("option", { name: /Claude Sonnet/ })
    const second = page.getByRole("option", { name: /GPT-4.1 mini/ })
    await userEvent.hover(first)
    const card = await page.findByRole("region", { name: "Model details" })
    await expect(within(card).getByText("$3.00 / million tokens")).toBeVisible()
    await expect(within(card).getByText("200,000 tokens")).toBeVisible()
    await userEvent.unhover(first)
    await userEvent.hover(second)
    await waitFor(() =>
      expect(within(card).getByText("$0.40 / million tokens")).toBeVisible()
    )
    await expect(
      page.getAllByRole("region", { name: "Model details" })
    ).toHaveLength(1)
    await expect(page.getByRole("region", { name: "Model details" })).toBe(card)
    await userEvent.unhover(second)
    await userEvent.hover(card)
    await expect(card).toBeVisible()
    await userEvent.unhover(card)
    await waitFor(() =>
      expect(
        page.queryByRole("region", { name: "Model details" })
      ).not.toBeInTheDocument()
    )
    await userEvent.hover(second)
    await page.findByRole("region", { name: "Model details" })
    await userEvent.click(second)
    await expect(changed).toHaveBeenLastCalledWith("openai/gpt-4.1-mini")
    await waitFor(() =>
      expect(
        page.queryByRole("region", { name: "Model details" })
      ).not.toBeInTheDocument()
    )
  },
}
export const MissingDetails: Story = {
  args: {
    models: [
      {
        id: "test/model",
        name: "Test model",
        creator: "test",
        type: "language",
        tags: [],
      },
    ],
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      within(canvasElement).getByRole("combobox", { name: "Model" })
    )
    await userEvent.hover(
      await page.findByRole("option", { name: /Test model/ })
    )
    const card = await page.findByRole("region", { name: "Model details" })
    await expect(within(card).getAllByText("Not available")).toHaveLength(4)
    await userEvent.keyboard("{Escape}")
    await waitFor(() =>
      expect(
        page.queryByRole("region", { name: "Model details" })
      ).not.toBeInTheDocument()
    )
  },
}
export const Empty: Story = { args: { models: [] } }
export const SavedOpenAIDuringError: Story = {
  args: {
    models: [],
    value: "openai/gpt-4.1-mini",
    error: "Unable to load the model catalog.",
    onRetry: retry,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    await expect(
      canvas.getByRole("combobox", { name: "Model" })
    ).toHaveTextContent("gpt-4.1-mini")
    await userEvent.click(canvas.getByRole("combobox", { name: "Model" }))
    await expect(
      await page.findByRole("group", { name: "OpenAI" })
    ).toBeVisible()
    await expect(page.getByRole("alert")).toHaveTextContent(
      "Unable to load the model catalog."
    )
    await userEvent.click(page.getByRole("button", { name: "Retry models" }))
    await expect(retry).toHaveBeenCalled()
  },
}
export const SavedModelDuringError: Story = {
  args: {
    models: [],
    value: "custom/saved",
    error: "Unable to load the model catalog.",
    onRetry: retry,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("combobox", { name: "Model" })
    ).toHaveTextContent("Saved model (unavailable)")
    await userEvent.click(canvas.getByRole("combobox", { name: "Model" }))
    await userEvent.click(
      await within(canvasElement.ownerDocument.body).findByRole("button", {
        name: "Retry models",
      })
    )
    await expect(retry).toHaveBeenCalled()
  },
}

export const DatoolScorerModel: Story = {
  args: { models: projectModels(gatewayModels, true) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole("combobox", { name: "Model" }))
    await userEvent.type(
      await page.findByRole("combobox", { name: "Search model" }),
      "Datool"
    )
    await userEvent.click(
      await page.findByRole("option", { name: /Datool Scorer Model/ })
    )
    await expect(changed).toHaveBeenLastCalledWith("datool/gpt-6-luna")
  },
}
