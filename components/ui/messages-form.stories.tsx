import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import { MessagesForm } from "./messages-form"

type Role = "system" | "user" | "assistant"

function Example({ disabled = false }: { disabled?: boolean }) {
  const [messages, setMessages] = useState<{ role: Role; content: string }[]>([
    { role: "system", content: "Help {{name}} with their request." },
  ])
  return (
    <div className="w-[480px] max-w-full p-4">
      <MessagesForm<Role>
        messages={messages}
        onChange={setMessages}
        roles={[
          { value: "system", label: "System" },
          { value: "user", label: "User" },
          { value: "assistant", label: "Assistant" },
        ]}
        defaultRole="user"
        maxMessages={2}
        disabled={disabled}
        description={
          <>Use {"{{variable}}"} for values supplied by your agent.</>
        }
      />
      <output aria-label="Message draft" className="sr-only">
        {JSON.stringify(messages)}
      </output>
    </div>
  )
}

const meta = {
  title: "UI/MessagesForm",
  component: MessagesForm,
  parameters: { layout: "fullscreen" },
  render: () => <Example />,
} satisfies Meta<typeof MessagesForm>
export default meta
type Story = StoryObj<typeof Example>

export const Editing: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole(
      "textbox",
      { name: "Message 1" },
      { timeout: 10_000 }
    )
    await expect(
      canvas.queryByRole("button", { name: "Remove message 1" })
    ).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("button", { name: "Message" }))
    await expect(canvas.getByRole("button", { name: "Message" })).toBeDisabled()
    const editor = await canvas.findByRole(
      "textbox",
      { name: "Message 2" },
      { timeout: 10_000 }
    )
    await userEvent.click(editor)
    await userEvent.paste("A sample answer.")
    await userEvent.click(
      canvas.getByRole("combobox", { name: "Message 2 role" })
    )
    await userEvent.click(
      await within(document.body).findByRole("option", {
        name: "Assistant",
      })
    )
    await expect(canvas.getByLabelText("Message draft")).toHaveTextContent(
      '"role":"assistant","content":"A sample answer."'
    )
    await expect(
      canvas.queryByRole("button", { name: "Remove message 1" })
    ).not.toBeInTheDocument()
    await userEvent.click(
      canvas.getByRole("button", { name: "Remove message 2" })
    )
    await expect(canvas.getByLabelText("Message draft")).toHaveTextContent(
      '[{"role":"system","content":"Help {{name}} with their request."}]'
    )
    await expect(canvas.getByRole("button", { name: "Message" })).toBeEnabled()
    await expect(
      canvas.queryByRole("button", { name: "Remove message 1" })
    ).not.toBeInTheDocument()
  },
}

export const Disabled: Story = {
  render: () => <Example disabled />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const editor = await canvas.findByRole(
      "textbox",
      { name: "Message 1" },
      { timeout: 10_000 }
    )
    await userEvent.click(editor)
    await userEvent.paste("Should not change.")
    await expect(canvas.getByLabelText("Message draft")).toHaveTextContent(
      '[{"role":"system","content":"Help {{name}} with their request."}]'
    )
    await expect(
      canvas.getByRole("combobox", { name: "Message 1 role" })
    ).toBeDisabled()
    await expect(
      canvas.queryByRole("button", { name: "Remove message 1" })
    ).not.toBeInTheDocument()
    await expect(canvas.getByRole("button", { name: "Message" })).toBeDisabled()
  },
}
