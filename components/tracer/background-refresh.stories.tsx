import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import type { ApiList } from "@/src/lib/tracer/contracts"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import { CollectionFilterBar } from "./collection-filter"
import { CollectionPage } from "./collection-page"
import { useRemote, type RemoteState } from "./hooks"
import { useCollectionPages } from "./use-collection-pages"

type Row = { id: string; name: string }
type Page = ApiList<Row>
let reads: { resolve: (page: Page) => void; reject: (error: Error) => void }[] =
  []
function load() {
  return new Promise<Page>((resolve, reject) => reads.push({ resolve, reject }))
}
const page = (revision: number): Page => ({
  items: [{ id: "example", name: `Revision ${revision}` }],
  nextCursor: null,
})

function PollingView({ state }: { state: RemoteState<Page> }) {
  return (
    <StorybookProjectFrame title="Background refresh">
      <CollectionPage
        state={state}
        loadingLabel="Loading examples"
        isEmpty={state.data?.items.length === 0}
        empty={<p>No examples</p>}
        header={{
          children: (
            <CollectionFilterBar
              resource="traces"
              value=""
              onChange={() => {}}
              error={null}
              isLoading={state.isLoading || state.isRefreshing}
            />
          ),
        }}
      >
        {state.data?.items.map((row) => (
          <p key={row.id}>{row.name}</p>
        ))}
      </CollectionPage>
    </StorybookProjectFrame>
  )
}

function RemoteExample() {
  const state = useRemote(load, [], { intervalMs: 250 })
  return <PollingView state={state} />
}
function CollectionExample() {
  const state = useCollectionPages(load, "", 250)
  return <PollingView state={state} />
}
function PollingExample({ collection = false }: { collection?: boolean }) {
  return collection ? <CollectionExample /> : <RemoteExample />
}

const meta = {
  title: "Tracer/BackgroundRefresh",
  component: PollingExample,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    reads = []
  },
} satisfies Meta<typeof PollingExample>
export default meta
type Story = StoryObj<typeof meta>

const quietRefresh: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement)
  const refresh = canvas.getByRole("button", { name: "Refresh" })
  const expectQuiet = async () => {
    await expect(refresh.querySelector(".animate-spin")).toBeNull()
    await expect(
      canvas.queryByRole("status", { name: "Updating results" })
    ).not.toBeInTheDocument()
    await expect(canvas.queryByText("Loading examples")).not.toBeInTheDocument()
  }
  await expect(canvas.findByText("Loading examples")).resolves.toBeVisible()
  await waitFor(() => expect(reads).toHaveLength(1))
  reads[0].resolve(page(1))
  await expect(canvas.findByText("Revision 1")).resolves.toBeVisible()
  await waitFor(() => expect(reads).toHaveLength(2))
  await expectQuiet()
  await expect(canvas.getByText("Revision 1")).toBeVisible()
  reads[1].resolve(page(2))
  await expect(canvas.findByText("Revision 2")).resolves.toBeVisible()

  // Returning to the tab is also a background read.
  document.dispatchEvent(new Event("visibilitychange"))
  await waitFor(() => expect(reads).toHaveLength(3))
  await expectQuiet()

  // An explicit refresh queued behind polling still receives loading feedback.
  await userEvent.click(refresh)
  reads[2].resolve(page(3))
  await waitFor(() => expect(reads).toHaveLength(4))
  await expect(canvas.findByText("Revision 3")).resolves.toBeVisible()
  await expect(refresh.querySelector(".animate-spin")).not.toBeNull()
  await expect(
    canvas.getByRole("status", { name: "Updating results" })
  ).toBeVisible()
  reads[3].resolve(page(4))
  await expect(canvas.findByText("Revision 4")).resolves.toBeVisible()
  await expectQuiet()
}

const quietRecovery: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement)
  await waitFor(() => expect(reads).toHaveLength(1))
  reads[0].reject(new Error("Unable to load examples"))
  await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
    "Unable to load examples"
  )
  await waitFor(() => expect(reads).toHaveLength(2))
  await expect(canvas.getByRole("alert")).toHaveTextContent(
    "Unable to load examples"
  )
  await expect(canvas.queryByRole("status")).not.toBeInTheDocument()
  reads[1].resolve({ items: [], nextCursor: null })
  await expect(canvas.findByText("No examples")).resolves.toBeVisible()
  await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  await waitFor(() => expect(reads).toHaveLength(3))
  await expect(canvas.getByText("No examples")).toBeVisible()
  await expect(canvas.queryByRole("status")).not.toBeInTheDocument()
  await expect(
    canvas
      .getByRole("button", { name: "Refresh" })
      .querySelector(".animate-spin")
  ).toBeNull()
  reads[2].resolve(page(1))
  await expect(canvas.findByText("Revision 1")).resolves.toBeVisible()
}

export const RemotePolling: Story = { play: quietRefresh }
export const CollectionPolling: Story = {
  args: { collection: true },
  play: quietRefresh,
}
export const RemoteRecovery: Story = { play: quietRecovery }
export const CollectionRecovery: Story = {
  args: { collection: true },
  play: quietRecovery,
}
