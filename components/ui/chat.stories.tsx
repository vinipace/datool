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

const longMessage = "https://example.test/" + "long-path-segment-".repeat(24)

export const MessageWrapping: Story = {
  args: {
    messages: [
      { role: "user", content: "hey", toolCalls: [] },
      { role: "user", content: longMessage, toolCalls: [] },
      { role: "assistant", content: "How can I help?", toolCalls: [] },
    ],
  },
  render: (args) => (
    <div className="flex flex-wrap gap-8">
      {[320, 640].map((width) => (
        <section
          key={width}
          aria-label={`Chat at ${width}px`}
          className="h-[32rem] max-w-full"
          style={{ width }}
        >
          <Chat {...args} />
        </section>
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    for (const width of [320, 640]) {
      const chat = within(
        canvas.getByRole("region", { name: `Chat at ${width}px` })
      )
      const short = chat.getByText("hey", { exact: true })
      const range = short.ownerDocument.createRange()
      range.selectNodeContents(short)
      await expect(range.getClientRects().length).toBe(1)

      const long = chat.getByRole("link", { name: longMessage }).closest("p")!
      await expect(long.scrollWidth).toBeLessThanOrEqual(long.clientWidth)
      const log = chat.getByRole("log", { name: "Conversation" })
      await expect(log.scrollWidth).toBeLessThanOrEqual(log.clientWidth)
      await expect(short.getBoundingClientRect().right).toBeGreaterThan(
        log.getBoundingClientRect().left + log.clientWidth / 2
      )
    }
  },
}
