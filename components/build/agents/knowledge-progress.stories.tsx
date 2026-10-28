import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { http, HttpResponse } from "msw"
import { ProjectScopeProvider } from "@/components/tracer/project-scope"
import { TracerAppShell } from "@/components/tracer/app-shell"
import { storybookOrganization } from "@/.storybook/scenarios/auth-workspace/fixtures"
import {
  storybookAuthHandlers,
  workspaceProjectHandlers,
} from "@/.storybook/scenarios/auth-workspace/handlers"
import {
  agentConfigurationSchema,
  type ManagedAgent,
} from "@/src/lib/build/contracts"
import type { KnowledgeSource } from "@/src/lib/build/knowledge"
import { BuildAgentEditor } from "./agent-editor"

const agent: ManagedAgent = {
  id: "knowledge-agent",
  projectId: "storybook-project",
  slug: "knowledge-agent",
  name: "Support agent",
  description: "",
  status: "active",
  currentRevision: 1,
  appliedRevision: 1,
  configuration: agentConfigurationSchema.parse({ model: "fixture-model" }),
  createdAt: "2026-10-28T00:00:00Z",
  updatedAt: "2026-10-28T00:00:00Z",
  archivedAt: null,
}
const initial: KnowledgeSource = {
  id: "website-source",
  projectId: agent.projectId,
  agentId: agent.id,
  name: "Documentation",
  kind: "website",
  uri: "https://example.test",
  status: "pending",
  statusMessage: null,
  revision: 1,
  activeRevision: 0,
  fileName: null,
  mimeType: null,
  nextResyncAt: null,
  lastIndexedAt: null,
  createdAt: agent.createdAt,
  updatedAt: agent.updatedAt,
}
let source = { ...initial }
const meta = {
  title: "Build/KnowledgeProgress",
  component: BuildAgentEditor,
  args: { agent, initialTab: "knowledge" },
  parameters: {
    layout: "fullscreen",
    nextjs: {
      navigation: { pathname: "/p/demo/build/agents/knowledge-agent" },
    },
    msw: {
      handlers: [
        http.get("*/api/custom-fields", () => HttpResponse.json({ data: [] })),
        http.post("*/api/build/:operation", ({ params }) => {
          if (params.operation === "build_list_knowledge_sources")
            return HttpResponse.json({ data: [source] })
          if (params.operation === "build_get_knowledge_source")
            return HttpResponse.json({
              data: {
                ...source,
                text: "",
                pairs: [],
                config: { maxPages: 100 },
              },
            })
          if (params.operation === "build_list_knowledge_pages")
            return HttpResponse.json({
              data: {
                revision: source.activeRevision,
                total: source.activeRevision ? 1 : 0,
                filteredTotal: source.activeRevision ? 1 : 0,
                items: source.activeRevision
                  ? [
                      {
                        url: "https://www.example.test/help",
                        title: "Help",
                        fetchedAt: agent.updatedAt,
                        contentType: "text/html",
                      },
                    ]
                  : [],
              },
            })
          return HttpResponse.json({ data: [] })
        }),
        ...storybookAuthHandlers,
        ...workspaceProjectHandlers(),
      ],
    },
  },
  decorators: [
    (Story) => (
      <ProjectScopeProvider
        projectId={agent.projectId}
        organizationId={storybookOrganization.id}
        prefix="/p/demo"
      >
        <div className="h-[900px]">
          <TracerAppShell
            buildEnabled
            organization={storybookOrganization}
            project={{ id: agent.projectId, name: "Demo", slug: "demo" }}
            user={{
              name: "Ana Martins",
              email: "ana@example.com",
              image: null,
            }}
          >
            <Story />
          </TracerAppShell>
        </div>
      </ProjectScopeProvider>
    ),
  ],
  beforeEach: () => {
    source = { ...initial }
  },
} satisfies Meta<typeof BuildAgentEditor>
export default meta
type Story = StoryObj<typeof meta>

export const LiveProgress: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Documentation" })
    )
    const dialog = within(
      await within(canvasElement.ownerDocument.body).findByRole("dialog", {
        name: "Edit website",
      })
    )
    await expect(
      dialog.findByText("Queued. Waiting for a worker to start.")
    ).resolves.toBeVisible()
    await userEvent.click(dialog.getByText("Source settings"))
    const name = dialog.getByRole("textbox", { name: "Name" })
    await userEvent.clear(name)
    await userEvent.type(name, "Unsaved name")

    source = {
      ...source,
      status: "indexing",
      statusMessage: "Crawling: 2 pages read, 12 discovered.",
    }
    await waitFor(
      () => expect(dialog.getByText(source.statusMessage!)).toBeVisible(),
      { timeout: 6000 }
    )
    await expect(name).toHaveValue("Unsaved name")
    source = {
      ...source,
      statusMessage: "Indexing 12 pages. Preparing content for your agent.",
    }
    await waitFor(
      () => expect(dialog.getByText(source.statusMessage!)).toBeVisible(),
      { timeout: 6000 }
    )
    source = {
      ...source,
      status: "ready",
      statusMessage: "1 pages indexed.",
      activeRevision: 1,
    }
    await waitFor(
      () => expect(dialog.getByRole("button", { name: /Help/ })).toBeVisible(),
      { timeout: 6000 }
    )
    await userEvent.click(dialog.getByText("Source settings"))
    await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Unsaved name"
    )
  },
}

export const CrawlFailed: Story = {
  beforeEach: () => {
    source = {
      ...initial,
      status: "error",
      statusMessage: "Could not read any pages. The source returned HTTP 403.",
    }
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("button", {
        name: "Documentation",
      })
    )
    const dialog = within(
      await within(canvasElement.ownerDocument.body).findByRole("dialog", {
        name: "Edit website",
      })
    )
    await expect(dialog.findByRole("alert")).resolves.toHaveTextContent(
      "HTTP 403"
    )
    await expect(
      dialog.findByText(
        "No pages indexed. Fix the source and reindex to try again."
      )
    ).resolves.toBeVisible()
  },
}

export const Crawling: Story = {
  beforeEach: () => {
    source = {
      ...initial,
      status: "indexing",
      statusMessage: "Crawling: 12 pages read, 65 discovered.",
    }
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("button", {
        name: "Documentation",
      })
    )
  },
}
