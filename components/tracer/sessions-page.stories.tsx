import { checkCollectionPanel, checkCompactCollectionPanel } from "../../.storybook/collection-panel-checks"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { delay, http, HttpResponse } from "msw"
import {
  StorybookProjectFrame,
  storybookProject,
} from "../../.storybook/component-frame"
import {
  sessionHandlers,
  traceHandlers,
} from "../../.storybook/scenarios/traces/handlers"
import { envelope, list, storybookSessionDetail, storybookSessionId, traceDetail, traceOverview, traceRows, traceSpans } from "../../.storybook/scenarios/traces/fixtures"
import { SessionDetailPage, SessionsPage } from "./sessions-page"

const meta = {
  title: "Tracer/SessionsPage",
  component: SessionsPage,
  parameters: {
    layout: "fullscreen",
    msw: { handlers: [
      http.get("/api/traces/:id/overview", ({ params }) => {
        const trace = traceRows.find(trace => trace.id === params.id)!
        return HttpResponse.json(envelope({ ...traceOverview, ...trace,
          spans: params.id === traceOverview.id ? traceOverview.spans : [],
        }))
      }),
      http.get("/api/traces/:id/payload", ({ params }) => HttpResponse.json(envelope(traceRows.find(trace => trace.id === params.id)))),
      http.get("/api/traces/:id/spans", ({ params }) => HttpResponse.json(envelope(list(params.id === traceOverview.id ? traceSpans : [])))),
      http.get("/api/traces/:id/scores", ({ params }) => HttpResponse.json(envelope(list(params.id === traceOverview.id ? traceDetail.scores.map((score, index) => ({ ...score, id: String(index) })) : [])))),
      ...sessionHandlers, ...traceHandlers,
    ] },
    nextjs: {
      navigation: {
        pathname: `${storybookProject.prefix}/sessions`,
        query: {},
      },
    },
  },
  loaders: [async () => {
    localStorage.removeItem("datool:session:inspector-tab")
    localStorage.removeItem("datool:trace-inspector:detail-tab")
    return {}
  }],
  render: () => (
    <StorybookProjectFrame title="Sessions">
      <SessionsPage />
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof SessionsPage>

export default meta
type Story = StoryObj<typeof meta>

export const Collection: Story = {
  play: async ({ canvasElement }) => {
    await checkCollectionPanel(canvasElement, "Sessions")
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("Invoice support conversation")
    ).resolves.toBeVisible()
    await expect(canvas.getByRole("img", { name: "session" })).toBeVisible()
    await expect(canvas.getByRole("link", { name: /Invoice support conversation/ })).toHaveAttribute("href", `${storybookProject.prefix}/sessions/${storybookSessionId}`)
    await userEvent.click(
      canvas.getByRole("checkbox", { name: "Select all visible sessions" })
    )
    await expect(
      canvas.getByRole("checkbox", { name: /Select session 1/ })
    ).toBeChecked()
  },
}

export const Detail: Story = {
  parameters: {
    nextjs: {
      navigation: {
        pathname: `${storybookProject.prefix}/sessions/${storybookSessionId}`,
        query: {},
      },
    },
  },
  render: () => (
    <StorybookProjectFrame title="Sessions">
      <SessionDetailPage sessionId={storybookSessionId} />
    </StorybookProjectFrame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("heading", {
        name: "Invoice support conversation",
      })
    ).resolves.toBeVisible()
    const conversation = within(canvas.getByRole("region", { name: "Session conversation" }))
    await expect(conversation.findByText("Where is my latest invoice?")).resolves.toBeVisible()
    await expect(conversation.findByText("Your September invoice is ready in the billing portal.")).resolves.toBeVisible()
    await expect(canvas.queryByText("Session ID")).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("button", { name: "Details" }))
    await expect(canvas.findByText("Session ID")).resolves.toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Metadata" }))
    await expect(canvas.findByRole("heading", { name: "Session attributes" })).resolves.toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Overview" }))
    const hierarchy = within(canvas.getByRole("region", { name: "Session trace hierarchy" }))
    await expect(hierarchy.getByRole("button", { name: /^session Invoice support conversation/ })).toHaveAttribute("aria-pressed", "true")
    await expect(hierarchy.getByRole("button", { name: /^agent Summarize account history/ })).toBeVisible()
    await userEvent.click(hierarchy.getByRole("button", { name: /^llm Generate invoice response/ }))
    await expect(canvas.findByRole("heading", { name: "Generate invoice response" })).resolves.toBeVisible()
    await expect(canvas.findByText("Where is my latest invoice?")).resolves.toBeVisible()
    await userEvent.click(hierarchy.getByRole("button", { name: /^agent Summarize account history/ }))
    await expect(canvas.findByRole("heading", { name: "Summarize account history" })).resolves.toBeVisible()
    await expect(canvas.findByText(/Summarize the account history/)).resolves.toBeVisible()
    await userEvent.click(hierarchy.getByRole("button", { name: "Collapse Invoice support conversation" }))
    await expect(hierarchy.queryByRole("button", { name: /^llm Generate invoice response/ })).not.toBeInTheDocument()
    const expand = hierarchy.getByRole("button", { name: "Expand Invoice support conversation" })
    expand.focus()
    await userEvent.keyboard("{Enter}")
    await expect(hierarchy.findByRole("button", { name: /^llm Generate invoice response/ })).resolves.toBeVisible()
    await userEvent.click(hierarchy.getByRole("button", { name: /^session Invoice support conversation/ }))
    await expect(canvas.findByRole("heading", { name: "Invoice support conversation" })).resolves.toBeVisible()
    await expect(canvas.getByRole("link", { name: "All sessions" })).toHaveAttribute("href", `${storybookProject.prefix}/sessions`)
    await userEvent.click(canvas.getByRole("button", { name: "Evaluators" }))
    await expect(canvas.findByText("Answer groundedness")).resolves.toBeVisible()
  },
}

export const DeepLinkedSpan: Story = {
  ...Detail,
  parameters: {
    nextjs: { navigation: {
      pathname: `${storybookProject.prefix}/sessions/${storybookSessionId}`,
      query: { trace: traceOverview.id, span: traceSpans[1].id },
    } },
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).findByRole("heading", { name: "Generate invoice response" })).resolves.toBeVisible()
  },
}

export const EmptySession: Story = {
  ...Detail,
  parameters: { ...Detail.parameters, msw: { handlers: [
    http.get("/api/sessions/:id", () => HttpResponse.json(envelope({ ...storybookSessionDetail, traceCount: 0, traces: [] }))),
    http.get("/api/traces", () => HttpResponse.json(envelope(list([])))),
  ] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("No traces are linked to this session yet.")).resolves.toBeVisible()
    await expect(canvas.getByRole("region", { name: "Session trace hierarchy" })).toBeVisible()
  },
}

export const FailedSession: Story = {
  ...Detail,
  parameters: { ...Detail.parameters, msw: { handlers: [
    http.get("/api/sessions/:id", () => HttpResponse.json({ error: { message: "Session unavailable" } }, { status: 503 })),
    http.get("/api/traces", () => HttpResponse.json(envelope(list([])))),
  ] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("Session unavailable")).resolves.toBeVisible()
    await expect(canvas.getByRole("button", { name: /retry/i })).toBeVisible()
  },
}

export const FailedConversation: Story = {
  ...Detail,
  parameters: { ...Detail.parameters, msw: { handlers: [
    http.get("/api/traces/:id/payload", () => HttpResponse.json({ error: { message: "Conversation unavailable" } }, { status: 503 })),
    ...meta.parameters.msw.handlers,
  ] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent("Could not load the complete conversation")
    await expect(canvas.getByRole("button", { name: "Retry" })).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Details" }))
    await expect(canvas.findByText("Session ID")).resolves.toBeVisible()
  },
}

export const LoadingConversation: Story = {
  ...Detail,
  parameters: { ...Detail.parameters, msw: { handlers: [
    http.get("/api/traces/:id/payload", async ({ params }) => {
      await delay(500)
      return HttpResponse.json(envelope(traceRows.find(trace => trace.id === params.id)))
    }),
    ...meta.parameters.msw.handlers,
  ] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("Loading session conversation…")).resolves.toBeVisible()
    await expect(canvas.findByText("Where is my latest invoice?")).resolves.toBeVisible()
  },
}

export const NarrowDetail: Story = {
  ...Detail,
  render: () => <div className="w-[390px] max-w-full"><StorybookProjectFrame title="Sessions"><SessionDetailPage sessionId={storybookSessionId} /></StorybookProjectFrame></div>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    await expect(canvas.findByText("Where is my latest invoice?")).resolves.toBeVisible()
    await expect(canvas.queryByRole("separator")).not.toBeInTheDocument()
    await expect(canvas.queryByRole("region", { name: "Session trace hierarchy" })).not.toBeInTheDocument()
    const trigger = canvas.getByRole("button", { name: "Browse traces" })
    await userEvent.click(trigger)
    let drawer = within(await page.findByRole("dialog", { name: "Trace navigator" }))
    await userEvent.click(drawer.getByRole("button", { name: "Collapse Invoice support conversation" }))
    await expect(drawer.queryByRole("button", { name: /^llm Generate invoice response/ })).not.toBeInTheDocument()
    await userEvent.click(drawer.getByRole("button", { name: "Expand Invoice support conversation" }))
    await userEvent.click(drawer.getByRole("button", { name: /^llm Generate invoice response/ }))
    await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument())
    await expect(canvas.findByRole("heading", { name: "Generate invoice response" })).resolves.toBeVisible()
    await expect(trigger).toHaveFocus()

    await userEvent.click(trigger)
    drawer = within(await page.findByRole("dialog", { name: "Trace navigator" }))
    await userEvent.click(drawer.getByRole("button", { name: /^session Invoice support conversation/ }))
    await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument())
    await expect(canvas.findByRole("heading", { name: "Invoice support conversation" })).resolves.toBeVisible()
    await expect(canvas.findByText("Where is my latest invoice?")).resolves.toBeVisible()
    await userEvent.click(trigger)
    await page.findByRole("dialog", { name: "Trace navigator" })
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument())
    await expect(trigger).toHaveFocus()
  },
}

export const NarrowCollection: Story = {
  parameters: Collection.parameters,
  render: () => <div className="w-[375px] max-w-full"><StorybookProjectFrame title="Sessions"><SessionsPage /></StorybookProjectFrame></div>,
  play: async ({ canvasElement }) => {
    await checkCompactCollectionPanel(canvasElement, "Sessions")
  },
}
