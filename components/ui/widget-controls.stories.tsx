import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fireEvent, fn, userEvent, within } from "storybook/test"
import {
  WidgetChoiceGroup,
  WidgetDatePicker,
} from "@/src/browser/widget-controls"
import "@/src/browser/widget-controls.css"
import { Button } from "./button"

const submitted = fn()
const options = [
  { id: "valen", label: "Macaquinho Valen" },
  { id: "bem", label: "Macacão Bem" },
  { id: "camisa", label: "Camisa" },
]

function Preferences({ multiple = true, disabled = false }) {
  const [selected, setSelected] = useState<string[]>([])
  const [date, setDate] = useState("")
  const [page, setPage] = useState(0)
  return (
    <form
      className="datool-chat-surface flex max-w-sm flex-col gap-4 bg-background p-4 text-foreground"
      onSubmit={(event) => {
        event.preventDefault()
        submitted({ selected, date })
      }}
    >
      <WidgetChoiceGroup
        label="Modelos"
        options={page === 0 ? options.slice(0, 2) : options.slice(2)}
        value={selected}
        onChange={setSelected}
        multiple={multiple}
        disabled={disabled}
      />
      <Button type="button" variant="outline" onClick={() => setPage(1 - page)}>
        {page === 0 ? "Mais modelos" : "Voltar aos modelos"}
      </Button>
      <WidgetDatePicker
        label="Data de uso"
        value={date}
        onChange={setDate}
        min="2026-11-05"
        locale="pt-BR"
        required
        disabled={disabled}
      />
      <Button type="submit" disabled={disabled || !selected.length}>
        Continuar
      </Button>
    </form>
  )
}

const meta = {
  title: "Build/Widget controls",
  component: Preferences,
  beforeEach: () => submitted.mockClear(),
} satisfies Meta<typeof Preferences>
export default meta
type Story = StoryObj<typeof meta>

export const MultipleModelsAndDate: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("button", { name: "Continuar" })
    ).toBeDisabled()
    await userEvent.click(
      canvas.getByRole("button", { name: "Macaquinho Valen" })
    )
    await userEvent.click(canvas.getByRole("button", { name: "Macacão Bem" }))
    await userEvent.click(canvas.getByRole("button", { name: "Mais modelos" }))
    await userEvent.click(
      canvas.getByRole("button", { name: /^Camisa$/ })
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Voltar aos modelos" })
    )
    await expect(
      canvas.getByRole("button", { name: "Macaquinho Valen" })
    ).toHaveAttribute("aria-pressed", "true")
    await expect(
      canvas.getByRole("button", { name: "Macacão Bem" })
    ).toHaveAttribute("aria-pressed", "true")
    await userEvent.click(
      canvas.getByRole("button", { name: "Macaquinho Valen" })
    )

    const date = canvas.getByLabelText("Data de uso") as HTMLInputElement
    fireEvent.change(date, { target: { value: "2026-11-04" } })
    await expect(date.checkValidity()).toBe(false)
    await userEvent.click(canvas.getByRole("button", { name: "Continuar" }))
    await expect(submitted).not.toHaveBeenCalled()
    fireEvent.change(date, { target: { value: "2026-12-20" } })
    await userEvent.click(canvas.getByRole("button", { name: "Continuar" }))
    await expect(submitted).toHaveBeenCalledTimes(1)
    await expect(submitted).toHaveBeenCalledWith({
      selected: ["bem", "camisa"],
      date: "2026-12-20",
    })
  },
}

export const SingleModel: Story = {
  args: { multiple: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: "Macaquinho Valen" })
    )
    await userEvent.click(canvas.getByRole("button", { name: "Macacão Bem" }))
    await expect(
      canvas.getByRole("button", { name: "Macaquinho Valen" })
    ).toHaveAttribute("aria-pressed", "false")
    await expect(
      canvas.getByRole("button", { name: "Macacão Bem" })
    ).toHaveAttribute("aria-pressed", "true")
  },
}

export const ReadOnly: Story = {
  args: { disabled: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("button", { name: "Macaquinho Valen" })
    ).toBeDisabled()
    await expect(canvas.getByLabelText("Data de uso")).toBeDisabled()
  },
}
