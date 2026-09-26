import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { useQuery } from "@tanstack/react-query"
import { delay, http, HttpResponse } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import {
  envelope,
  list,
  traceRow,
  traceRows,
} from "../../.storybook/scenarios/traces/fixtures"
import { tracerApi } from "./api"
import { CollectionFilterBar } from "./collection-filter"
import { CollectionPage, CollectionSearch } from "./collection-page"
import { CollectionPanel } from "./collection-panel"

function CollectionExample({ pagination = false }: { pagination?: boolean }) {
  const [filter, setFilter] = React.useState("")
  const [loadedMore, setLoadedMore] = React.useState(false)
  const query = useQuery({
    queryKey: ["storybook", "traces", filter],
    queryFn: () => tracerApi.traces.list({ filter, limit: 2 }),
  })
  const rows = [
    ...(query.data?.items ?? []),
    ...(loadedMore
      ? [
          {
            ...traceRow,
            id: "trace-storybook-003",
            name: "Review invoice delivery",
            operation: "workflow.reviewInvoiceDelivery",
          },
        ]
      : []),
  ]

  return (
    <StorybookProjectFrame title="Traces">
      <CollectionPanel label="Traces">
        <CollectionPage
          className="contents"
          empty={
            <p className="p-4 text-sm text-foreground-muted">No traces yet</p>
          }
          header={{
            children: (
              <CollectionFilterBar
                error={null}
                isLoading={query.isFetching}
                onChange={setFilter}
                resource="traces"
                value={filter}
              />
            ),
            exportName: "traces",
            exportRows: rows,
          }}
          isEmpty={query.data?.items.length === 0}
          loadingLabel="Loading traces"
          pagination={
            pagination
              ? {
                  canLoadMore: !loadedMore,
                  isLive: false,
                  isLoadingMore: false,
                  loadMore: () => setLoadedMore(true),
                  loadMoreError: null,
                }
              : undefined
          }
          state={{
            data: query.data ?? null,
            error: query.error,
            isLoading: query.isPending,
            isRefreshing: query.isFetching && !query.isPending,
            refresh: () => void query.refetch(),
          }}
        >
          <ul aria-label="Traces" className="space-y-2 p-2">
            {rows.map((trace) => (
              <li
                key={trace.id}
                className="rounded-md border border-border bg-muted p-3 text-sm"
              >
                {trace.name}
              </li>
            ))}
          </ul>
        </CollectionPage>
      </CollectionPanel>
    </StorybookProjectFrame>
  )
}

function CollectionSearchExample() {
  const [value, setValue] = React.useState("")
  return (
    <StorybookProjectFrame title="Trace search">
      <div className="p-4">
        <CollectionSearch
          label="Search traces"
          onChange={setValue}
          value={value}
        />
        <p className="mt-3 text-sm text-foreground-muted">
          Current search: {value || "all traces"}
        </p>
      </div>
    </StorybookProjectFrame>
  )
}

const meta = {
  title: "Tracer/CollectionPage",
  component: CollectionPage,
  parameters: { layout: "fullscreen" },
  render: () => <CollectionExample />,
} satisfies Meta<typeof CollectionPage>

export default meta
type Story = StoryObj<typeof CollectionExample>

export const Populated: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/traces", () =>
          HttpResponse.json(envelope(list(traceRows)))
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("Resolve invoice question")
    ).resolves.toBeVisible()
    await expect(
      canvas.findByRole("button", { name: "Refresh" })
    ).resolves.toBeVisible()
  },
}

export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/traces", () => HttpResponse.json(envelope(list([])))),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("No traces yet")
    ).resolves.toBeVisible()
  },
}

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/traces", async () => {
          await delay("infinite")
          return HttpResponse.json(envelope(list(traceRows)))
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("status", { name: "" })
    ).resolves.toHaveTextContent("Loading traces")
    const controls = canvas.getByRole("group", { name: "Traces controls" })
    await expect(
      controls.querySelector('[data-slot="collection-display-skeleton"]')
    ).toBeVisible()
    const loading = canvas.getByRole("status", { name: "" })
    await expect(loading.getBoundingClientRect().height).toBeGreaterThan(300)
    await expect(loading.parentElement!.scrollHeight).toBeLessThanOrEqual(
      loading.parentElement!.clientHeight
    )
    await userEvent.click(
      canvas.getByRole("combobox", { name: "Filter expression" })
    )
    await expect(
      canvas.getByRole("combobox", { name: "Filter expression" })
    ).toHaveFocus()
    await expect(loading).toHaveTextContent("Loading traces")
  },
}

export const NarrowLoading: Story = {
  ...Loading,
  render: () => (
    <div className="w-[300px] max-w-full">
      <CollectionExample />
    </div>
  ),
  play: async (context) => {
    await Loading.play?.(context)
    const canvas = within(context.canvasElement)
    const controls = canvas.getByRole("group", { name: "Traces controls" })
    await expect(controls.scrollWidth).toBe(controls.clientWidth)
    await expect(controls.getBoundingClientRect().height).toBe(53)
    const menu = canvas.getByRole("button", { name: "More actions" })
    await userEvent.click(menu)
    await expect(
      within(context.canvasElement.ownerDocument.body).getByRole("menuitem", {
        name: "Refresh",
      })
    ).toBeVisible()
    await userEvent.keyboard("{Escape}")
    await waitFor(() =>
      expect(menu).toHaveFocus()
    )
  },
}

export const InitialFailure: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/traces", () =>
          HttpResponse.json(
            {
              error: {
                code: "INTERNAL_ERROR",
                message: "Trace service unavailable",
              },
            },
            { status: 500 }
          )
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("alert")
    ).resolves.toHaveTextContent("Trace service unavailable")
  },
}

export const Retry: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get(
          "/api/traces",
          () =>
            HttpResponse.json(
              {
                error: {
                  code: "READ_TIMEOUT",
                  message: "Timed out reading traces",
                },
              },
              { status: 503 }
            ),
          { once: true }
        ),
        http.get("/api/traces", () =>
          HttpResponse.json(envelope(list(traceRows)))
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("alert")
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }))
    await expect(
      canvas.findByText("Resolve invoice question")
    ).resolves.toBeVisible()
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
  },
}

export const RefreshFailureRetainsRows: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get(
          "/api/traces",
          () => HttpResponse.json(envelope(list(traceRows))),
          { once: true }
        ),
        http.get("/api/traces", () =>
          HttpResponse.json(
            {
              error: { code: "READ_TIMEOUT", message: "Refresh timed out" },
            },
            { status: 503 }
          )
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Resolve invoice question")
    await userEvent.click(canvas.getByRole("button", { name: "Refresh" }))
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Refresh timed out"
    )
    await expect(canvas.getByText("Resolve invoice question")).toBeVisible()
  },
}

export const HeaderPortalsAndPagination: Story = {
  render: () => <CollectionExample pagination />,
  parameters: {
    msw: {
      handlers: [
        http.get("/api/traces", () =>
          HttpResponse.json(envelope(list(traceRows, "trace-page-2")))
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Resolve invoice question")
    await expect(
      canvas.getByRole("search", { name: "Filter traces" })
    ).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Load more" }))
    await expect(
      canvas.findByText("Review invoice delivery")
    ).resolves.toBeVisible()
  },
}

export const PlainTextSearch: Story = {
  render: () => <CollectionSearchExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      await canvas.findByRole("textbox", { name: "Search traces" }),
      "invoice"
    )
    await expect(canvas.getByText("Current search: invoice")).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Clear search" }))
    await expect(canvas.getByText("Current search: all traces")).toBeVisible()
    await expect(
      canvas.getByRole("textbox", { name: "Search traces" })
    ).toHaveFocus()
  },
}
