import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, within } from "storybook/test"
import Link from "next/link"
import { Plus } from "lucide-react"
import { Button } from "./button"

const meta = {
  title: "UI/Button",
  component: Button,
  args: { children: "Create dataset", onClick: fn() },
} satisfies Meta<typeof Button>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Create dataset" })
    )
    await expect(args.onClick).toHaveBeenCalledOnce()
  },
}

export const Variants: Story = {
  render: (args) => (
    <div className="flex max-w-xl flex-wrap gap-3">
      {(
        [
          "default",
          "marketing",
          "secondary",
          "outline",
          "ghost",
          "ghost-muted",
          "ghost-subtle",
          "link",
          "destructive",
        ] as const
      ).map((variant) => (
        <Button key={variant} {...args} variant={variant}>
          {variant}
        </Button>
      ))}
    </div>
  ),
}

export const Sizes: Story = {
  render: (args) => (
    <div className="flex max-w-xl flex-wrap items-center gap-3">
      {(
        [
          "sm",
          "default",
          "responsive-sm",
          "lg",
          "xl",
          "2xl",
          "icon",
          "icon-sm",
          "icon-lg",
        ] as const
      ).map((size) => (
        <Button
          key={size}
          {...args}
          aria-label={size.startsWith("icon") ? `${size} button` : undefined}
          size={size}
        >
          {size.startsWith("icon") ? <Plus aria-hidden="true" /> : size}
        </Button>
      ))}
    </div>
  ),
}

export const WithIcon: Story = {
  render: (args) => (
    <Button {...args}>
      <Plus aria-hidden="true" />
      Create dataset
    </Button>
  ),
}

export const Disabled: Story = {
  args: { disabled: true },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button")).toBeDisabled()
  },
}

export const Loading: Story = {
  args: { loading: true, children: "Creating dataset" },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole("button")
    await expect(button).toBeDisabled()
    await expect(button).toHaveAttribute("aria-busy", "true")
  },
}

export const Invalid: Story = {
  args: { "aria-invalid": true, children: "Fix validation" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button")).toHaveAttribute(
      "aria-invalid",
      "true"
    )
  },
}

export const AsLink: Story = {
  render: () => (
    <Button asChild variant="outline">
      <Link href="/">Open workspace</Link>
    </Button>
  ),
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("link", { name: "Open workspace" })
    ).toHaveAttribute("href", "/")
  },
}
