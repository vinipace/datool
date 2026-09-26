import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { CollectionScrollBoundary } from "./collection-scroll-boundary"
import { Button } from "@/components/ui/button"

function ScrollBoundaryExample({
  loadMoreError = null,
}: {
  loadMoreError?: Error | null
}) {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  return (
    <div
      ref={scrollRef}
      className="h-48 overflow-auto rounded border border-border"
    >
      <div className="h-40 p-3 text-sm text-foreground-muted">
        Loaded trace rows
      </div>
      <CollectionScrollBoundary
        label="traces"
        scrollRef={scrollRef}
        state={{
          canLoadMore: false,
          error: null,
          isLoading: false,
          isLoadingMore: false,
          isRefreshing: false,
          loadMore: fn(),
          loadMoreError,
          refresh: fn(),
        }}
      />
    </div>
  )
}

const meta = {
  title: "Tracer/CollectionScrollBoundary",
  component: CollectionScrollBoundary,
  render: () => <ScrollBoundaryExample />,
} satisfies Meta<typeof CollectionScrollBoundary>

export default meta
type Story = StoryObj<typeof ScrollBoundaryExample>

export const Ready: Story = {}

function BackgroundFetchExample({ loadMore }: { loadMore: () => void }) {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const [isFetching, setFetching] = React.useState(true)
  return (
    <>
      <Button onClick={() => setFetching(false)}>
        Finish background refresh
      </Button>
      <div ref={scrollRef} className="h-48 overflow-auto">
        <p>Loaded rows</p>
        <CollectionScrollBoundary
          label="traces"
          scrollRef={scrollRef}
          state={{
            canLoadMore: true,
            isLoading: false,
            isLoadingMore: false,
            isRefreshing: false,
            isFetching,
            error: null,
            loadMoreError: null,
            loadMore,
            refresh: () => {},
          }}
        />
      </div>
    </>
  )
}

const loadAfterRefresh = fn()
export const WaitsForBackgroundFetch: Story = {
  render: () => <BackgroundFetchExample loadMore={loadAfterRefresh} />,
  beforeEach: () => {
    loadAfterRefresh.mockClear()
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )
    await expect(canvas.queryByRole("status")).not.toBeInTheDocument()
    await expect(loadAfterRefresh).not.toHaveBeenCalled()
    await userEvent.click(
      canvas.getByRole("button", { name: "Finish background refresh" })
    )
    await waitFor(() => expect(loadAfterRefresh).toHaveBeenCalledTimes(1))
  },
}

export const RetryAfterFailure: Story = {
  render: () => (
    <ScrollBoundaryExample
      loadMoreError={new Error("The next page timed out.")}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      "Could not load traces"
    )
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }))
  },
}
