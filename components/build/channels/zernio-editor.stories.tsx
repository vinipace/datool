import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { delay, http, HttpResponse } from "msw"
import {
  agentConfigurationSchema,
  type ManagedAgent,
} from "@/src/lib/build/contracts"
import type { ChannelConnection } from "@/src/lib/build/channels"
import { ZernioEditor } from "./zernio-editor"

const agent: ManagedAgent = {
  id: "preview-agent",
  projectId: "preview-project",
  slug: "assistant",
  name: "Store assistant",
  description: "",
  status: "active",
  currentRevision: 1,
  appliedRevision: 1,
  configuration: agentConfigurationSchema.parse({ model: "fixture-model" }),
  createdAt: "2026-10-26T12:00:00Z",
  updatedAt: "2026-10-26T12:00:00Z",
  archivedAt: null,
}
const connection: ChannelConnection = {
  id: "preview-channel",
  projectId: agent.projectId,
  organizationId: null,
  agentId: agent.id,
  channel: "whatsapp",
  label: "WhatsApp",
  status: "draft",
  externalId: null,
  config: { provider: "zernio" },
  lastError: null,
  lastInboundAt: null,
  lastOutboundAt: null,
  createdAt: agent.createdAt,
  updatedAt: agent.updatedAt,
}
function fixture(
  status: "draft" | "connected" | "paused" | "error" | "loading"
) {
  return [
    http.post("/api/build/:operation", async ({ params }) => {
      if (params.operation === "build_list_whatsapp_templates")
        return HttpResponse.json({ data: { items: [] } })
      if (status === "loading") await delay("infinite")
      if (status === "error")
        return HttpResponse.json(
          { error: { message: "Status unavailable" } },
          { status: 503 }
        )
      return HttpResponse.json({
        data: {
          configured: true,
          status,
          account:
            status === "draft"
              ? null
              : { displayPhoneNumber: "+1 555 555 0123", mode: "coexistence" },
        },
      })
    }),
  ]
}
const meta = {
  title: "Build/OfficialWhatsAppConnection",
  component: ZernioEditor,
  args: { connection, agent, fromAgent: true },
  parameters: {
    layout: "fullscreen",
    nextjs: {
      navigation: { pathname: "/p/demo/build/integrations/preview-channel" },
    },
    msw: { handlers: fixture("draft") },
  },
} satisfies Meta<typeof ZernioEditor>
export default meta
type Story = StoryObj<typeof meta>
export const Connect: Story = {}
export const Connected: Story = {
  parameters: { msw: { handlers: fixture("connected") } },
}
export const Paused: Story = {
  parameters: { msw: { handlers: fixture("paused") } },
}
export const Loading: Story = {
  parameters: { msw: { handlers: fixture("loading") } },
}
export const Error: Story = {
  parameters: { msw: { handlers: fixture("error") } },
}
