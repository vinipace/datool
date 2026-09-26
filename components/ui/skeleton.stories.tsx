import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { Skeleton } from "./skeleton"

const meta = {
  title: "UI/Skeleton",
  component: Skeleton,
  render: () => (
    <div role="status" aria-label="Loading content" className="w-80 max-w-full space-y-3">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
    </div>
  ),
} satisfies Meta<typeof Skeleton>

export default meta
type Story = StoryObj<typeof meta>

export const ContentPlaceholder: Story = {}
