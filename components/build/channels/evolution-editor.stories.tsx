import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { delay, http, HttpResponse } from "msw"
import { expect, userEvent, within } from "storybook/test"
import {
  agentConfigurationSchema,
  type ManagedAgent,
} from "@/src/lib/build/contracts"
import type { ChannelConnection } from "@/src/lib/build/channels"
import type { EvolutionConnection } from "@/src/lib/build/evolution"
import { EvolutionEditor } from "./evolution-editor"

const agent: ManagedAgent = {
  id: "preview-agent",
  projectId: "preview-project",
  slug: "store-assistant",
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
  label: "WhatsApp · Evolution",
  status: "disconnected",
  externalId: null,
  config: { provider: "evolution" },
  lastError: null,
  lastInboundAt: null,
  lastOutboundAt: null,
  createdAt: agent.createdAt,
  updatedAt: agent.updatedAt,
}
const initial: EvolutionConnection = {
  enabled: true,
  connectionId: connection.id,
  status: "disconnected",
  state: "close",
  phone: null,
  checkedAt: null,
  cleanupPending: false,
}
// A labelled, non-scannable illustration; previews never connect a real phone.
const previewQr = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="white"/><g fill="none" stroke="black" stroke-width="8"><path d="M20 20h64v64H20zM172 20h64v64h-64zM20 172h64v64H20z"/><path d="M40 40h24v24H40zM192 40h24v24h-24zM40 192h24v24H40z"/></g><text x="128" y="136" text-anchor="middle" font-family="sans-serif" font-size="14">PREVIEW ONLY</text></svg>')}`

type Mode =
  | "auto-connect"
  | "default"
  | "loading"
  | "status-error"
  | "pair-error"
  | "disconnect-error"
function scenario(
  overrides: Partial<EvolutionConnection> = {},
  mode: Mode = "default"
) {
  let state = { ...initial, ...overrides }
  let connectsAt = 0
  return {
    reset: () => {
      state = { ...initial, ...overrides }
      connectsAt = 0
    },
    handlers: [
      http.post("/api/build/:operation", async ({ params, request }) => {
        const input = (await request.json()) as Record<string, unknown>
        const op = params.operation
        if (op === "build_get_evolution_connection") {
          if (connectsAt && Date.now() >= connectsAt)
            state = {
              ...state,
              state: "open",
              status: "connected",
              phone: "15555550123",
            }
          if (mode === "loading") await delay("infinite")
          if (mode === "status-error")
            return HttpResponse.json(
              { error: { message: "Status unavailable" } },
              { status: 503 }
            )
        }
        if (op === "build_begin_evolution_connection") {
          await delay(800)
          if (mode === "pair-error")
            return HttpResponse.json(
              {
                error: {
                  message: "Could not generate a QR code. Please try again.",
                },
              },
              { status: 503 }
            )
          state = {
            ...state,
            state: "connecting",
            checkedAt: new Date().toISOString(),
          }
          if (mode === "auto-connect") connectsAt = Date.now() + 4000
          return HttpResponse.json({
            data: {
              ...state,
              qr: previewQr,
              expiresAt: new Date(Date.now() + 30_000).toISOString(),
            },
          })
        }
        if (op === "build_disconnect_evolution") {
          await delay(500)
          if (mode === "disconnect-error")
            return HttpResponse.json(
              {
                error: {
                  message:
                    "The remote session could not be removed. Please try again.",
                },
              },
              { status: 503 }
            )
          state = { ...initial }
        }
        if (op === "build_update_channel_status")
          state = { ...state, status: String(input.status) }
        if (op === "build_refresh_evolution_connection")
          state = { ...state, checkedAt: new Date().toISOString() }
        return HttpResponse.json({ data: state })
      }),
    ],
  }
}
const idle = scenario()
const meta = {
  title: "Build/EvolutionConnection",
  component: EvolutionEditor,
  args: { connection, agent, fromAgent: true },
  parameters: {
    layout: "fullscreen",
    nextjs: {
      navigation: { pathname: "/p/demo/build/integrations/preview-channel" },
    },
    msw: { handlers: idle.handlers },
  },
  beforeEach: idle.reset,
} satisfies Meta<typeof EvolutionEditor>
export default meta
type Story = StoryObj<typeof meta>
export const Connect: Story = {}
function withScenario(
  overrides: Partial<EvolutionConnection>,
  mode?: Mode
): Story {
  const fixture = scenario(overrides, mode)
  return {
    beforeEach: fixture.reset,
    parameters: { msw: { handlers: fixture.handlers } },
  }
}
export const Connected: Story = withScenario({
  state: "open",
  status: "connected",
  phone: "15555550123",
  checkedAt: "2026-10-26T12:00:00Z",
})
export const Paused: Story = withScenario({
  state: "open",
  status: "paused",
  phone: "15555550123",
})
export const ConnectionLost: Story = withScenario({ phone: "15555550123" })
export const CleanupPending: Story = withScenario({ cleanupPending: true })
export const PilotDisabled: Story = withScenario({ enabled: false })
export const Loading: Story = withScenario({}, "loading")
export const StatusError: Story = withScenario({}, "status-error")
export const PairError: Story = withScenario({}, "pair-error")
export const DisconnectError: Story = withScenario(
  { state: "open", status: "connected", phone: "15555550123" },
  "disconnect-error"
)

export const ScanDetectedDuringCountdown: Story = {
  ...withScenario({}, "auto-connect"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole("checkbox"))
    await userEvent.click(
      canvas.getByRole("button", { name: "Generate QR code" })
    )
    await expect(
      canvas.findByRole("img", { name: /Scan this QR code/ })
    ).resolves.toBeVisible()
    // The expiry countdown re-renders every second; it must not restart the
    // slower connection poll and prevent a scanned number from being detected.
    await expect(
      canvas.findByRole("heading", { name: "+15555550123" }, { timeout: 12000 })
    ).resolves.toBeVisible()
    await expect(
      canvas.queryByRole("img", { name: /Scan this QR code/ })
    ).not.toBeInTheDocument()
  },
}
