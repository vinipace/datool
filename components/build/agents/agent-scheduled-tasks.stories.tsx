import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { http, HttpResponse } from "msw"
import { agentConfigurationSchema } from "@/src/lib/build/contracts"
import type { ScheduledTask } from "@/src/lib/build/schedules"
import { AgentScheduledTasks } from "./agent-scheduled-tasks"

const original: ScheduledTask = {
  id: "00000000-0000-4000-8000-000000000001",
  agentId: "sdk-agent",
  name: "Daily briefing",
  prompt: "Read the workspace company context.",
  channel: "api",
  schedule: { kind: "cron", expression: "0 9 * * *" },
  timezone: "UTC",
  status: "active",
  revision: 1,
  nextRunAt: "2027-01-01T09:00:00Z",
  lastRun: null,
  createdAt: "2026-11-09T12:00:00Z",
  updatedAt: "2026-11-09T12:00:00Z",
  sdkContext: {
    connectionId: "00000000-0000-4000-8000-000000000002",
    conversationId: "acme-chat",
    driveId: "00000000-0000-4000-8000-000000000003",
    workspace: "drive_acme",
    workspaceName: "Acme Studio",
  },
}
let task = original
let updates: Record<string, unknown>[] = []
const meta = {
  title: "Build/AgentScheduledTasks",
  component: AgentScheduledTasks,
  args: {
    agentId: "sdk-agent",
    configuration: agentConfigurationSchema.parse({}),
  },
  beforeEach: () => {
    task = { ...original }
    updates = []
  },
  decorators: [
    (Story) => (
      <div className="h-dvh">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    nextjs: { navigation: { pathname: "/p/demo/build/agents/sdk-agent" } },
    msw: {
      handlers: [
        http.post("*/api/build/build_list_scheduled_tasks", () =>
          HttpResponse.json({ data: { items: [task], nextCursor: null } })
        ),
        http.post(
          "*/api/build/build_update_scheduled_task",
          async ({ request }) => {
            const body = (await request.json()) as Record<string, unknown>
            updates.push(body)
            task = {
              ...task,
              revision: task.revision + 1,
              name: String(body.name),
              status: body.enabled ? "active" : "paused",
            }
            return HttpResponse.json({ data: task })
          }
        ),
      ],
    },
  },
} satisfies Meta<typeof AgentScheduledTasks>
export default meta
type Story = StoryObj<typeof meta>
export const SdkWorkspaceContext: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("Acme Studio")).resolves.toBeVisible()
    await expect(canvas.getByText("SDK-managed")).toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: "Daily briefing" })
    )
    const dialog = within(await within(document.body).findByRole("dialog"))
    await expect(
      dialog.getByText(/original workspace, drive and conversation/)
    ).toBeVisible()
    await expect(
      dialog.getByRole("link", { name: "Open workspace conversation" })
    ).toHaveAttribute("href", expect.stringContaining("conversation=acme-chat"))
    await userEvent.click(
      dialog.getByText("Advanced settings", { exact: true })
    )
    await expect(
      dialog.getByRole("combobox", { name: "Channel settings" })
    ).toBeDisabled()
    await userEvent.clear(dialog.getByRole("textbox", { name: "Name" }))
    await userEvent.type(
      dialog.getByRole("textbox", { name: "Name" }),
      "Acme morning briefing"
    )
    await userEvent.click(dialog.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(updates).toHaveLength(1))
    await expect(updates[0]).toMatchObject({
      id: original.id,
      channel: "api",
      name: "Acme morning briefing",
    })
    await expect(updates[0]).not.toHaveProperty("sdkContext")
    await expect(
      canvas.findByRole("button", { name: "Acme morning briefing" })
    ).resolves.toBeVisible()
    await expect(canvas.getByText("Acme Studio")).toBeVisible()
  },
}
