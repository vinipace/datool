import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { getRouter } from "@storybook/nextjs-vite/navigation.mock"
import { delay, http, HttpResponse } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import {
  defaultAlertConfig,
  type AlertNotification,
} from "@/src/lib/alerts/contracts"
import { AlertsPage, AlertDetailPage } from "./alerts-page"

const endpoint = "/api/projects/alerts-story/alerts"
const rule = {
  id: "alert-1",
  revision: 1,
  config: {
    ...defaultAlertConfig,
    name: "Request errors",
    filter: "status = 'errored'",
  },
  createdAt: "2026-09-17T10:00:00Z",
  lastNotifiedAt: null,
  lastEvaluatedAt: null,
  lastError: null,
}
const empty = { alerts: [], deliveries: [], workerOnline: true }
const notifications: AlertNotification[] = [
  {
    id: "delivery-1",
    alertId: rule.id,
    alertName: rule.config.name,
    action: "webhook",
    status: "delivered",
    attempts: 2,
    lastError: null,
    createdAt: "2026-09-17T10:00:00Z",
    deliveredAt: "2026-09-17T10:00:05Z",
    payload: { matchCount: 1 },
    matchCount: 1,
    traceId: "trace-1",
    traceName: "Failed checkout",
  },
  {
    id: "delivery-2",
    alertId: rule.id,
    alertName: rule.config.name,
    action: "webhook",
    status: "failed",
    attempts: 5,
    lastError: "Webhook returned HTTP 503.",
    createdAt: "2026-09-17T09:00:00Z",
    deliveredAt: null,
    payload: { matchCount: 4 },
    matchCount: 4,
    traceId: null,
    traceName: null,
  },
]
const detailHandlers = [
  http.get(`${endpoint}/alert-1`, () =>
    HttpResponse.json({ alert: rule, workerOnline: true })
  ),
  http.get(`${endpoint}/alert-1/notifications`, () =>
    HttpResponse.json({ items: notifications, nextCursor: null, total: 2 })
  ),
]
const meta = {
  title: "Workspace/AlertsPage",
  component: AlertsPage,
  args: {
    projectId: "alerts-story",
    projectSlug: "alerts-story",
    canManage: true,
  },
  parameters: {
    layout: "fullscreen",
    nextjs: { navigation: { pathname: "/p/alerts-story/alerts", query: {} } },
    msw: { handlers: [http.get(endpoint, () => HttpResponse.json(empty))] },
  },
  render: (args) => (
    <StorybookProjectFrame
      projectId={args.projectId}
      prefix="/p/alerts-story"
      title="Alerts"
    >
      <AlertsPage {...args} />
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof AlertsPage>
export default meta
type Story = StoryObj<typeof meta>
export const Empty: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("No alerts yet")).resolves.toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "New alert" })
    ).toBeEnabled()
  },
}
export const TemplateDialog: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "New alert" })
    )
    const dialog = within(
      await within(canvasElement.ownerDocument.body).findByRole("dialog", {
        name: "New alert",
      })
    )
    await expect(dialog.getAllByRole("radio")).toHaveLength(7)
    await expect(
      dialog.getByRole("radio", { name: "Empty alert" })
    ).toBeChecked()
    await userEvent.click(dialog.getByRole("radio", { name: "Error burst" }))
  },
}
export const CreationNavigation: Story = {
  beforeEach: () => {
    getRouter().push.mockClear()
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    const trigger = canvas.getByRole("button", { name: "New alert" })
    await userEvent.click(trigger)
    let dialog = within(await body.findByRole("dialog", { name: "New alert" }))
    await userEvent.click(dialog.getByRole("radio", { name: "Error burst" }))
    await userEvent.keyboard("{Escape}")
    await waitFor(() =>
      expect(body.queryByRole("dialog")).not.toBeInTheDocument()
    )
    await waitFor(() => expect(trigger).toHaveFocus())
    await expect(getRouter().push).not.toHaveBeenCalled()
    await userEvent.click(trigger)
    dialog = within(await body.findByRole("dialog", { name: "New alert" }))
    await expect(
      dialog.getByRole("radio", { name: "Empty alert" })
    ).toBeChecked()
    await userEvent.click(dialog.getByRole("button", { name: "Continue" }))
    await expect(getRouter().push).toHaveBeenCalledWith(
      "/p/alerts-story/alerts/new"
    )
    await userEvent.click(trigger)
    dialog = within(await body.findByRole("dialog", { name: "New alert" }))
    await userEvent.click(
      dialog.getByRole("radio", { name: "Request failures" })
    )
    await userEvent.click(dialog.getByRole("button", { name: "Continue" }))
    await expect(getRouter().push).toHaveBeenCalledWith(
      "/p/alerts-story/alerts/new?template=request-failures"
    )
  },
}
export const Rules: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get(endpoint, () =>
          HttpResponse.json({ ...empty, alerts: [rule] })
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("link", { name: "Request errors" })
    ).resolves.toHaveAttribute("href", "/p/alerts-story/alerts/alert-1")
    await userEvent.click(canvas.getByRole("button", { name: "Display" }))
    await expect(
      within(canvasElement.ownerDocument.body).findByText("Visible columns")
    ).resolves.toBeVisible()
    await userEvent.keyboard("{Escape}")
  },
}
export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get(endpoint, async () => {
          await delay("infinite")
          return HttpResponse.json(empty)
        }),
      ],
    },
  },
}
export const LoadError: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get(endpoint, () =>
          HttpResponse.json(
            { error: { message: "Unable to load alerts." } },
            { status: 503 }
          )
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("alert")
    ).resolves.toHaveTextContent("Unable to load alerts.")
  },
}
export const History: Story = {
  parameters: {
    nextjs: {
      navigation: { pathname: "/p/alerts-story/alerts/alert-1", query: {} },
    },
    msw: { handlers: detailHandlers },
  },
  render: (args) => (
    <StorybookProjectFrame
      projectId={args.projectId}
      prefix="/p/alerts-story"
      title="Alert notifications"
      breadcrumbs={[{ label: "Alerts", href: "/p/alerts-story/alerts" }]}
    >
      <AlertDetailPage {...args} alertId="alert-1" />
    </StorybookProjectFrame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("Delivered", { exact: true })
    ).resolves.toBeVisible()
    await expect(canvas.getByText("Failed", { exact: true })).toBeVisible()
    await expect(
      canvas.getByRole("link", { name: "Edit alert" })
    ).toHaveAttribute("href", "/p/alerts-story/alerts/alert-1/edit")
    await expect(
      canvas.getByRole("link", { name: "View trace Failed checkout" })
    ).toHaveAttribute("href", "/p/alerts-story/traces/trace-1")
  },
}
export const ReadOnly: Story = {
  ...History,
  args: { canManage: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Delivered", { exact: true })
    await expect(
      canvas.queryByRole("link", { name: "Edit alert" })
    ).not.toBeInTheDocument()
    await expect(canvas.queryByRole("switch")).not.toBeInTheDocument()
  },
}
export const WorkerOffline: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get(endpoint, () =>
          HttpResponse.json({ ...empty, workerOnline: false, alerts: [rule] })
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText(/The alert worker is offline/)
    ).resolves.toBeVisible()
  },
}
