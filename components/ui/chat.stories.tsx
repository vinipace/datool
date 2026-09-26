import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, within } from "storybook/test"
import { Chat } from "./chat"

const submitted = fn()

function Conversation(props: React.ComponentProps<typeof Chat>) {
  const [text, setText] = useState(props.text)
  return (
    <form
      className="h-96 w-full max-w-lg"
      onSubmit={(event) => {
        event.preventDefault()
        submitted(text)
      }}
    >
      <Chat
        {...props}
        text={text}
        onTextChange={setText}
        canSubmit={!props.running && Boolean(text.trim())}
      />
    </form>
  )
}

const meta = {
  title: "UI/Chat",
  component: Chat,
  args: {
    messages: [],
    text: "",
    onTextChange: fn(),
    running: false,
    canSubmit: false,
  },
  beforeEach: () => {
    submitted.mockClear()
  },
  render: (args) => <Conversation {...args} />,
} satisfies Meta<typeof Chat>
export default meta
type Story = StoryObj<typeof meta>

export const Compose: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText("Start a conversation")).toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "Send message" })
    ).toBeDisabled()
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Message" }),
      "Hello"
    )
    await expect(
      canvas.getByRole("button", { name: "Send message" })
    ).toBeEnabled()
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}Again")
    await expect(submitted).not.toHaveBeenCalled()
    await userEvent.keyboard("{Enter}")
    await expect(submitted).toHaveBeenLastCalledWith("Hello\nAgain")
  },
}

export const Waiting: Story = {
  args: {
    messages: [{ role: "user", content: "Hello", toolCalls: [] }],
    text: "A retained draft",
    running: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("log", { name: "Conversation" })
    ).toHaveAttribute("aria-busy", "true")
    await expect(
      canvas.getByRole("textbox", { name: "Message" })
    ).toHaveAttribute("readonly")
    await expect(
      canvas.getByRole("button", { name: "Send message" })
    ).toBeDisabled()
    await expect(canvas.getByText("Hello")).toBeVisible()
  },
}
