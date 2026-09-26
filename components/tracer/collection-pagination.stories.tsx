import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, within } from "storybook/test"
import { CollectionPagination } from "./collection-pagination"

const loadMore = fn()

const meta = {
  title: "Tracer/CollectionPagination",
  component: CollectionPagination,
  args: {
    canLoadMore: true,
    isLive: false,
    isLoadingMore: false,
    loadMore,
    loadMoreError: null,
  },
} satisfies Meta<typeof CollectionPagination>

export default meta
type Story = StoryObj<typeof meta>

export const HistoryPage: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Load more" }))
    await expect(loadMore).toHaveBeenCalled()
  },
}

export const LoadFailure: Story = {
  args: {
    canLoadMore: false,
    isLive: true,
    loadMoreError: new Error("The next page timed out."),
  },
}
