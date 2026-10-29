import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import type { WidgetTranslations } from "@/src/lib/build/widget-i18n"
import { WidgetTranslationsEditor } from "./widget-translations-editor"

const meta = {
  title: "Build/WidgetTranslations",
  component: WidgetTranslationsEditor,
  args: { onChange: () => {} },
  render: function TranslationEditor(args) {
    const [translations, setTranslations] = useState<WidgetTranslations>(
      args.translations ?? {}
    )
    return (
      <div className="mx-auto max-w-3xl p-5">
        <WidgetTranslationsEditor
          {...args}
          translations={translations}
          onChange={setTranslations}
        />
      </div>
    )
  },
} satisfies Meta<typeof WidgetTranslationsEditor>
export default meta
type Story = StoryObj<typeof meta>

export const EditLanguages: Story = {
  args: {
    textKeys: [
      "Request a demo",
      "Name",
      "Email for this request",
      "What would you like to explore?",
    ],
    translations: {
      "pt-BR": { "Request a demo": "Solicitar demonstração", Name: "Nome" },
      es: { Name: "Nombre" },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "2 of 4 translated · 2 missing"
    )
    const language = canvas.getByRole("combobox", {
      name: "Translation language",
    })
    const email = canvas.getByRole("textbox", {
      name: "Português (Brasil) translation for Email for this request",
    })
    await userEvent.type(email, "E-mail para este pedido")
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "3 of 4 translated · 1 missing"
    )
    await userEvent.selectOptions(language, "es")
    await expect(
      canvas.getByRole("textbox", { name: "Español translation for Name" })
    ).toHaveValue("Nombre")
    await expect(
      canvas.getByRole("textbox", {
        name: "Español translation for Email for this request",
      })
    ).toHaveValue("")
    await userEvent.selectOptions(language, "pt-BR")
    await expect(email).toHaveValue("E-mail para este pedido")
    await userEvent.click(canvas.getByRole("button", { name: "Add text" }))
    const original = canvas.getByRole("textbox", { name: "Original text" })
    await expect(original).toHaveFocus()
    await userEvent.type(original, "Name")
    await expect(original).toBeInvalid()
    await expect(
      canvas.getByRole("button", { name: /^Add$/ })
    ).toBeDisabled()
    await userEvent.clear(original)
    await userEvent.type(original, "Website{Enter}")
    await expect(
      canvas.getByRole("textbox", {
        name: "Português (Brasil) translation for Website",
      })
    ).toBeVisible()
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "3 of 5 translated · 2 missing"
    )
    await expect(canvas.getByRole("button", { name: "Add text" })).toHaveFocus()
  },
}

export const Empty: Story = {
  args: { textKeys: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText("No text to translate yet")).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Add text" }))
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Original text" }),
      "Discard this{Escape}"
    )
    await expect(canvas.queryByRole("textbox")).not.toBeInTheDocument()
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "0 of 0 translated"
    )
    await expect(canvas.getByRole("button", { name: "Add text" })).toHaveFocus()
  },
}
