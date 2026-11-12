import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import {
  agentAppearanceSchema,
  type AgentAppearance,
} from "@/src/lib/build/contracts"
import { AgentAvatar, AgentAvatarPicker } from "./agent-avatar"

const meta = {
  title: "UI/AgentAvatar",
  component: AgentAvatarPicker,
  args: {
    value: agentAppearanceSchema.parse({
      avatarStyle: "star",
      avatarColor: "yellow",
    }),
    onChange: () => {},
  },
  render: function Picker(args) {
    const [appearance, setAppearance] = useState(args.value)
    return (
      <AgentAvatarPicker
        value={appearance}
        onChange={(next) => setAppearance(agentAppearanceSchema.parse(next))}
      />
    )
  },
} satisfies Meta<typeof AgentAvatarPicker>
export default meta
type Story = StoryObj<typeof meta>

export const Picker: Story = {
  // Selection must retain the other dimension and remain keyboard-operable.
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const cube = canvas.getByRole("button", {
      name: "Cube avatar",
    })
    cube.focus()
    await userEvent.keyboard("{Enter}")
    await userEvent.click(
      canvas.getByRole("button", { name: "Cobalt avatar color" })
    )
    await expect(cube).toHaveAttribute("aria-pressed", "true")
    await expect(
      canvas.getByRole("button", { name: "Cobalt avatar color" })
    ).toHaveAttribute("aria-pressed", "true")
    await expect(
      canvas.getByRole("button", { name: "Yellow avatar color" })
    ).toHaveAttribute("aria-pressed", "false")
    await userEvent.click(canvas.getByRole("button", { name: "Happy avatar" }))
    await expect(cube).toHaveAttribute("aria-pressed", "false")
    await expect(
      canvas.getByRole("button", { name: "Cobalt avatar color" })
    ).toHaveAttribute("aria-pressed", "true")
  },
}

const characters: Pick<AgentAppearance, "avatarStyle" | "avatarColor">[] = [
  { avatarStyle: "star", avatarColor: "yellow" },
  { avatarStyle: "cube", avatarColor: "coral" },
  { avatarStyle: "circle", avatarColor: "lime" },
  { avatarStyle: "flower", avatarColor: "magenta" },
  { avatarStyle: "diamond", avatarColor: "cobalt" },
  { avatarStyle: "arch", avatarColor: "teal" },
  { avatarStyle: "triangle", avatarColor: "cyan" },
  { avatarStyle: "heart", avatarColor: "scarlet" },
  { avatarStyle: "friendly", avatarColor: "orange" },
  { avatarStyle: "happy", avatarColor: "midnight" },
  { avatarStyle: "wink", avatarColor: "violet" },
  { avatarStyle: "calm", avatarColor: "rose" },
]

export const CharacterGallery: Story = {
  render: () => (
    <div className="grid max-w-3xl grid-cols-3 gap-6 sm:grid-cols-6">
      {characters.map((appearance) => (
        <div
          key={appearance.avatarStyle}
          className="flex flex-col items-center gap-3"
        >
          <AgentAvatar
            appearance={appearance}
            className="size-20 rounded-2xl"
          />
          <span className="text-xs text-foreground-muted capitalize">
            {appearance.avatarStyle}
          </span>
          <div className="flex items-center gap-2">
            <AgentAvatar appearance={appearance} className="size-6" />
            <AgentAvatar appearance={appearance} className="size-8" />
          </div>
        </div>
      ))}
    </div>
  ),
}
