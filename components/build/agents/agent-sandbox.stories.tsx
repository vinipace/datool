import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { http, HttpResponse } from "msw"
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
