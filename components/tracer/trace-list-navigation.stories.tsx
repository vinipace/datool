import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { getRouter } from "@storybook/nextjs-vite/navigation.mock"
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime"
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime"
import { expect, spyOn, userEvent, waitFor, within } from "storybook/test"
import { http, HttpResponse } from "msw"
import {
  StorybookProjectFrame,
  storybookProject,
} from "../../.storybook/component-frame"
import { traceHandlers } from "../../.storybook/scenarios/traces/handlers"
import {
  envelope,
  erroredTraceRow,
  list,
  storybookTraceId,
  traceOverview,
} from "../../.storybook/scenarios/traces/fixtures"
import { InspectorPanels } from "./inspector-panels"
import { TraceListWorkspace } from "./trace-list"

const pathname = `${storybookProject.prefix}/traces`
const listHref = `${pathname}?filter=status%3Acompleted`

// Emulate Next's native-history/search-params integration. Router push/replace
// only record calls: opening the inspector must not need a server navigation.
function NavigationWorkspace({ initialHref }: { initialHref: string }) {
  const [history, setHistory] = React.useState([initialHref])
  const href = history[history.length - 1]
  const originalUrl = React.useRef(window.location.href)
  const nativeReplace = React.useRef(window.history.replaceState.bind(window.history))
  const searchParams = React.useMemo(
    () => new URL(href, "http://storybook.local").searchParams,
    [href]
  )
  const router = React.useMemo(
    () => ({
      ...getRouter(),
      bfcacheId: "trace-navigation-story",
      back: () =>
        setHistory((entries) =>
          entries.length > 1 ? entries.slice(0, -1) : entries
        ),
    }),
    []
  )

  // Maximize/restore also reads the address bar, so keep it in sync with the
  // simulated stack without adding entries to the test runner's real history.
  React.useLayoutEffect(() => {
    nativeReplace.current(null, "", href)
  }, [href])

  React.useEffect(() => {
    const relativeHref = (url: string | URL) => {
      const parsed = new URL(url, window.location.origin)
      return `${parsed.pathname}${parsed.search}${parsed.hash}`
    }
    const restoreUrl = originalUrl.current
    const restore = nativeReplace.current
    const push = spyOn(window.history, "pushState").mockImplementation((_state, _unused, url) => {
      if (url) setHistory(entries => [...entries, relativeHref(url)])
    })
    const replace = spyOn(window.history, "replaceState").mockImplementation((_state, _unused, url) => {
      if (url) setHistory(entries => [...entries.slice(0, -1), relativeHref(url)])
    })
    return () => {
      push.mockRestore()
      replace.mockRestore()
      restore(null, "", restoreUrl)
    }
  }, [])

  return (
    <AppRouterContext.Provider value={router}>
      <SearchParamsContext.Provider value={searchParams}>
        <StorybookProjectFrame title="Traces">
          <InspectorPanels>
            <TraceListWorkspace />
          </InspectorPanels>
        </StorybookProjectFrame>
        <output aria-label="Current URL">{href}</output>
      </SearchParamsContext.Provider>
    </AppRouterContext.Provider>
  )
}

const meta = {
  title: "Tracer/TraceListNavigation",
  component: NavigationWorkspace,
  args: { initialHref: listHref },
  parameters: {
    layout: "fullscreen",
    // The existing trace workspace has documented contrast debt.
    a11y: { test: "todo" },
    nextjs: { navigation: { pathname, query: {} } },
    msw: {
      handlers: [
        http.get(`/api/traces/${erroredTraceRow.id}/overview`, () =>
          HttpResponse.json(
            envelope({ ...traceOverview, ...erroredTraceRow, spans: [], scores: [] })
          )
        ),
        http.get(`/api/traces/${erroredTraceRow.id}/payload`, () =>
          HttpResponse.json(envelope(erroredTraceRow))
        ),
        http.get(`/api/traces/${erroredTraceRow.id}/scores`, () =>
          HttpResponse.json(envelope(list([])))
        ),
        ...traceHandlers,
      ],
    },
  },
  beforeEach: () => {
    localStorage.removeItem("datool:trace-inspector:detail-tab")
    localStorage.removeItem("datool:trace-inspector:tab")
  },
} satisfies Meta<typeof NavigationWorkspace>

export default meta
type Story = StoryObj<typeof meta>

export const CloseAfterSwitchingRows: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const first = await canvas.findByRole("row", {
      name: /^Open Resolve invoice question,/,
    })
    const second = canvas.getByRole("row", {
      name: /^Open Summarize account history,/,
    })

    for (const closeWith of ["Escape", "button"]) {
      await userEvent.click(first)
      await waitFor(() =>
        expect(
          canvas.getByRole("button", { name: "Close trace inspector" })
        ).toBeVisible()
      )
      // Re-selecting the same row must not add an extra history entry either.
      await userEvent.click(first)
      await userEvent.click(second)
      await waitFor(() =>
        expect(canvas.getByLabelText("Current URL")).toHaveTextContent(
          `trace=${erroredTraceRow.id}`
        )
      )
      await expect(
        canvas.findByRole("heading", { name: erroredTraceRow.name })
      ).resolves.toBeVisible()

      if (closeWith === "Escape") {
        await userEvent.keyboard("{Escape}")
      } else {
        await userEvent.click(
          canvas.getByRole("button", { name: "Close trace inspector" })
        )
      }

      await waitFor(() =>
        expect(
          canvas.queryByRole("button", { name: "Close trace inspector" })
        ).not.toBeInTheDocument()
      )
      await expect(canvas.getByLabelText("Current URL")).toHaveTextContent(listHref)
      await expect(second).toHaveFocus()
    }
  },
}

export const CloseAfterSwitchingFromDeepLink: Story = {
  args: {
    initialHref: `${listHref}&trace=${storybookTraceId}&span=span-storybook-model`,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("heading", { name: "Generate invoice response" })
    ).resolves.toBeVisible()
    const second = await canvas.findByRole("row", {
      name: /^Open Summarize account history,/,
    })
    await userEvent.click(second)
    await expect(
      canvas.findByRole("heading", { name: erroredTraceRow.name })
    ).resolves.toBeVisible()
    await userEvent.keyboard("{Escape}")
    await waitFor(() =>
      expect(
        canvas.queryByRole("button", { name: "Close trace inspector" })
      ).not.toBeInTheDocument()
    )
    await expect(canvas.getByLabelText("Current URL")).toHaveTextContent(listHref)
    await expect(canvas.getByLabelText("Current URL")).not.toHaveTextContent("span=")
    await expect(second).toHaveFocus()
  },
}

export const CloseMaximizedDeepLink: Story = {
  args: {
    initialHref: `${listHref}&trace=${storybookTraceId}&span=span-storybook-model&inspector=full`,
  },
  beforeEach: () => {
    const originalUrl = window.location.href
    const url = new URL(originalUrl)
    url.searchParams.set("inspector", "full")
    window.history.replaceState(null, "", url)
    return () => window.history.replaceState(null, "", originalUrl)
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByRole("button", { name: "Restore trace panel" })).resolves.toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Close trace inspector" }))
    await waitFor(() => expect(canvas.queryByRole("button", { name: "Close trace inspector" })).not.toBeInTheDocument())
    await expect(canvas.getByLabelText("Current URL").textContent).toBe(listHref)
    await expect(new URL(window.location.href).searchParams.has("inspector")).toBe(false)

    const row = await canvas.findByRole("row", { name: /^Open Resolve invoice question,/ })
    await userEvent.click(row)
    await waitFor(() => expect(canvas.getByRole("button", { name: "Maximize trace" })).toBeVisible())
  },
}

let finishOverview: (() => void) | undefined

export const OpensBeforeTraceLoads: Story = {
  beforeEach: () => {
    finishOverview = undefined
    return () => finishOverview?.()
  },
  parameters: {
    msw: {
      handlers: [
        http.get(`/api/traces/${storybookTraceId}/overview`, async () => {
          await new Promise<void>(resolve => { finishOverview = resolve })
          return HttpResponse.json(envelope(traceOverview))
        }),
        ...traceHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const row = await canvas.findByRole("row", { name: /^Open Resolve invoice question,/ })
    await userEvent.click(row)
    const loading = await canvas.findByRole("status", { name: "Loading trace" })
    await expect(loading).toBeVisible()
    await expect(loading.querySelector('[data-slot="skeleton"]')).toBeVisible()
    await expect(canvas.getByRole("button", { name: "Close trace inspector" })).toBeVisible()
    await expect(canvas.getByLabelText("Current URL")).toHaveTextContent(`trace=${storybookTraceId}`)
    await waitFor(() => expect(finishOverview).toBeDefined())
    finishOverview!()
    await expect(canvas.findByRole("heading", { name: "Resolve invoice question" })).resolves.toBeVisible()
    await expect(canvas.queryByRole("status", { name: "Loading trace" })).not.toBeInTheDocument()

    // A slow response must not reopen an inspector dismissed while loading.
    await userEvent.keyboard("{Escape}")
    finishOverview = undefined
    await userEvent.click(row)
    await expect(canvas.findByRole("status", { name: "Loading trace" })).resolves.toBeVisible()
    await waitFor(() => expect(finishOverview).toBeDefined())
    await userEvent.keyboard("{Escape}")
    finishOverview!()
    await waitFor(() => expect(canvas.queryByRole("region", { name: "Trace" })).not.toBeInTheDocument())
    await expect(canvas.getByLabelText("Current URL")).toHaveTextContent(listHref)
    await expect(row).toHaveFocus()
  },
}
