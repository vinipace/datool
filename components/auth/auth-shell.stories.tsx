import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, within } from "storybook/test"
import { AuthShell } from "./auth-shell"

const meta = {
  title: "Auth/AuthShell",
  component: AuthShell,
  parameters: { layout: "fullscreen" },
  args: {
    title: "Sign in",
    children: (
      <p className="text-sm text-foreground-muted">Identity provider</p>
    ),
  },
} satisfies Meta<typeof AuthShell>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole("main")).toBeVisible()
    await expect(canvas.getByRole("heading", { name: "Sign in" })).toBeVisible()
    await expect(canvas.getByText("datool")).toBeVisible()
  },
}

export const SupportingContent: Story = {
  args: {
    title: "Connect your workspace",
    description: "Authorize a scoped MCP connection for an existing project.",
    children: (
      <div className="grid gap-2 text-sm text-foreground-muted">
        <p>Access stays limited to the selected organization and project.</p>
        <a className="text-foreground underline" href="/">
          Return to workspace
        </a>
      </div>
    ),
  },
}
