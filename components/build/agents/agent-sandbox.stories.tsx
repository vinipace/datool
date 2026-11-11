import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { http, HttpResponse } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { agentConfigurationSchema } from "@/src/lib/build/contracts"
import type { AgentDrive } from "@/src/lib/build/sandbox"
import { AgentSandbox } from "./agent-sandbox"

const research: AgentDrive = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Customer research",
  description: "Interview notes, analysis and research scripts.",
  provider: "datool",
  createdAt: "2026-11-08T12:00:00Z",
}
let savedDrives: AgentDrive[] = [research]
const meta = {
  title: "Build/AgentSandbox",
  component: AgentSandbox,
  beforeEach: () => {
    savedDrives = [research]
  },
  args: {
    configuration: agentConfigurationSchema.parse({
      sandbox: {
        enabled: true,
        drives: [{ driveId: research.id, mountPath: "/workspace/research" }],
        workingDirectory: "/workspace/research",
      },
    }),
    onChange: () => {},
  },
  render: function Render(args) {
    const [configuration, setConfiguration] = React.useState(args.configuration)
    return (
      <div className="h-dvh">
        <AgentSandbox
          agentId={args.agentId}
          configuration={configuration}
          onChange={setConfiguration}
        />
      </div>
    )
  },
  parameters: {
    layout: "fullscreen",
    nextjs: { navigation: { pathname: "/p/demo/build/agents/research" } },
    msw: {
      handlers: [
        http.post("*/api/build/build_list_storage_connections", () => HttpResponse.json({data:{items:[]}})),
        http.post("*/api/build/build_list_drives", () =>
          HttpResponse.json({ data: { items: savedDrives, nextCursor: null } })
        ),
        http.post("*/api/build/build_create_drive", async ({ request }) => {
          const drive = {
            ...((await request.json()) as AgentDrive),
            id: crypto.randomUUID(),
            createdAt: "2026-11-08T12:00:00Z",
          }
          savedDrives.push(drive)
          return HttpResponse.json({ data: drive })
        }),
      ],
    },
  },
} satisfies Meta<typeof AgentSandbox>
export default meta
type Story = StoryObj<typeof meta>
export const Mounted: Story = {}
export const Empty: Story = {
  args: { configuration: agentConfigurationSchema.parse({}) },
}
export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post("*/api/build/build_list_drives", async () => {
          await new Promise((resolve) => setTimeout(resolve, 60_000))
          return HttpResponse.json({ data: { items: [], nextCursor: null } })
        }),
      ],
    },
  },
}
export const Error: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post("*/api/build/build_list_drives", () =>
          HttpResponse.json(
            { error: { message: "Drives could not be loaded." } },
            { status: 503 }
          )
        ),
      ],
    },
  },
}

export const SdkWorkspaceDrives: Story = {
  args: { agentId: "sdk-agent" },
  beforeEach: () => {
    savedDrives = [
      research,
      ...["acme", "orbit", "other"].map((workspace, index) => ({
        ...research,
        id: `00000000-0000-4000-8000-00000000000${index + 2}`,
        name: `drive_${workspace}`,
        sdkContext: {
          agentId: workspace === "other" ? "other-agent" : "sdk-agent",
          connectionId: "connection",
          workspace,
          workspaceName: `${workspace === "acme" ? "Acme Studio" : workspace === "orbit" ? "Orbit Labs" : "Other company"}`,
        },
      })),
    ]
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("Acme Studio")).resolves.toBeVisible()
    await expect(canvas.getByText("Orbit Labs")).toBeVisible()
    await expect(canvas.queryByText("Other company")).not.toBeInTheDocument()
    await expect(canvas.getAllByText("SDK-managed")).toHaveLength(2)
    await expect(
      canvas.queryByRole("button", { name: "Unmount drive_acme" })
    ).not.toBeInTheDocument()
    await expect(
      canvas.getByRole("button", { name: "Unmount Customer research" })
    ).toBeVisible()
    const search = canvas.getByRole("textbox", { name: "Search drives" })
    await userEvent.type(search, "Orbit Labs")
    await waitFor(() =>
      expect(canvas.queryByText("Acme Studio")).not.toBeInTheDocument()
    )
    await expect(canvas.getByText("Orbit Labs")).toBeVisible()
    await userEvent.clear(search)
    await userEvent.click(canvas.getByRole("button", { name: "Add drive" }))
    const dialog = within(await within(document.body).findByRole("dialog"))
    await expect(dialog.queryByText("drive_acme")).not.toBeInTheDocument()
    await expect(dialog.queryByText("drive_orbit")).not.toBeInTheDocument()
  },
}
