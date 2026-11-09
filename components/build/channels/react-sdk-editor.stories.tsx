import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import { http, HttpResponse } from "msw"
import {
  agentConfigurationSchema,
  type ManagedAgent,
} from "@/src/lib/build/contracts"
import type { ChannelConnection } from "@/src/lib/build/channels"
import { ReactSdkEditor } from "./react-sdk-editor"

const agent: ManagedAgent = {
  id: "agent",
  projectId: "project",
  slug: "assistant",
  name: "Assistant",
  description: null,
  status: "active",
  currentRevision: 1,
  appliedRevision: 1,
  configuration: agentConfigurationSchema.parse({}),
  createdAt: "2026-11-09T00:00:00Z",
  updatedAt: "2026-11-09T00:00:00Z",
  archivedAt: null,
}
const connection: ChannelConnection = {
  id: "ab603abe-521a-4eb9-920d-eef60f1dce93",
  projectId: "project",
  organizationId: "org",
  agentId: agent.id,
  channel: "api",
  label: "React SDK",
  status: "draft",
  externalId: null,
  config: {},
  lastError: null,
  lastInboundAt: null,
  lastOutboundAt: null,
  createdAt: "2026-11-09T00:00:00Z",
  updatedAt: "2026-11-09T00:00:00Z",
}
let status: ChannelConnection["status"] = "draft"
const meta = {
  title: "Build/ReactSdkEditor",
  component: ReactSdkEditor,
  args: { connection, agent },
  beforeEach: () => {
    status = "draft"
  },
  parameters: {
    layout: "fullscreen",
    msw: {
      handlers: [
        http.post("*/api/build/:operation", async ({ params, request }) => {
          if (params.operation === "build_update_channel_status")
            status = (
              (await request.json()) as { status: ChannelConnection["status"] }
            ).status
          return HttpResponse.json({
            data: { connection: { ...connection, status } },
          })
        }),
      ],
    },
  },
} satisfies Meta<typeof ReactSdkEditor>
export default meta
type Story = StoryObj<typeof meta>
export const Setup: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("heading", { name: "React SDK" })
    ).toBeVisible()
    await expect(canvas.getByText("app/api/datool/route.ts")).toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: "Enable channel" })
    )
    await expect(
      canvas.findByRole("button", { name: "Pause channel" })
    ).resolves.toBeVisible()
    await userEvent.click(canvas.getByRole("tab", { name: "Proactive agent" }))
    await expect(
      canvas.getByRole("heading", {
        name: "Give your agent context and a schedule",
      })
    ).toBeVisible()
    await expect(canvas.getByRole("link", { name: "Sandbox" })).toBeVisible()
  },
}
