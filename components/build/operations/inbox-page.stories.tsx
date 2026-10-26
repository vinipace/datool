import { useSyncExternalStore } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import {
  ReadonlyURLSearchParams,
  useSearchParams,
} from "@storybook/nextjs-vite/navigation.mock"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { delay, http, HttpResponse } from "msw"
import { TracerAppShell } from "@/components/tracer/app-shell"
import { ProjectScopeProvider } from "@/components/tracer/project-scope"
import { subscribeBrowserNavigation } from "@/components/navigation/navigation"
import { storybookOrganization } from "@/.storybook/scenarios/auth-workspace/fixtures"
import {
  storybookAuthHandlers,
  workspaceProjectHandlers,
} from "@/.storybook/scenarios/auth-workspace/handlers"
import { InboxPage } from "./inbox-page"

const tickets = [
  {
    id: "ticket-1",
    contactName: "Marina Costa",
    subject: "Can you help me find the right size?",
    channel: "web",
    status: "open",
    assigneeName: "Ana Martins",
  },
  {
    id: "ticket-2",
    contactName: "Vinicius Pacheco",
    subject: "Hi! I'd like to check on my order.",
    channel: "telegram",
    status: "open",
    assigneeName: null,
  },
  {
    id: "ticket-3",
    needsTakeover: true,
    contactName: null,
    subject:
      "Quero falar com um atendente humano. Tem alguém disponível agora?",
    channel: "web",
    status: "open",
    assigneeName: null,
  },
  {
    id: "ticket-4",
    contactName: "Emma Wilson",
    subject: "Thanks for helping me with the exchange!",
    channel: "web",
    status: "solved",
    assigneeName: "Ana Martins",
  },
].map((ticket, index) => ({
  ...ticket,
  conversationId: `conversation-${index}`,
  version: 1,
  priority: "normal",
  updatedAt: "2026-10-26T15:33:00Z",
}))

const messages = [
  {
    id: "message-1",
    role: "user",
    text: "Hi! Can you help me find the right size? I'm looking at the everyday jacket.",
    createdAt: "2026-10-26T15:30:00Z",
  },
  {
    id: "message-2",
    role: "assistant",
    author: { name: "Shop assistant" },
    text: "Of course. I can connect you with our team to help you choose the best fit.",
    createdAt: "2026-10-26T15:30:00Z",
  },
  {
    id: "message-3",
    role: "user",
    text: "That would be great, thank you!",
    createdAt: "2026-10-26T15:31:00Z",
  },
  {
    id: "message-4",
    role: "assistant",
    author: { name: "Ana Martins" },
    metadata: { source: "human" },
    text: "Hi Marina! I'm here to help. What size do you usually wear?",
    createdAt: "2026-10-26T15:33:00Z",
  },
]

const listHandler = http.post(
  "/api/build/build_list_tickets",
  async ({ request }) => {
    const input = (await request.json()) as {
      status?: string
      queue?: string
      search?: string
    }
    const items = tickets.filter(
      (ticket) =>
        (!input.status || ticket.status === input.status) &&
        (!input.queue ||
          (input.queue === "unassigned"
            ? !ticket.assigneeName
            : !!ticket.assigneeName)) &&
        (!input.search ||
          `${ticket.contactName} ${ticket.subject}`
            .toLowerCase()
            .includes(input.search.toLowerCase()))
    )
    return HttpResponse.json({ data: { items, nextCursor: null } })
  }
)
const handlers = [
  http.get("/api/custom-fields", () =>
    HttpResponse.json({ data: { items: [], nextCursor: null } })
  ),
  listHandler,
  http.post("/api/build/build_get_ticket", async ({ request }) => {
    const { id } = (await request.json()) as { id: string }
    return HttpResponse.json({
      data: tickets.find((ticket) => ticket.id === id),
    })
  }),
  http.post("/api/build/build_get_conversation", () =>
    HttpResponse.json({ data: { ownerType: "human" } })
  ),
  http.post("/api/build/build_list_conversation_messages", () =>
    HttpResponse.json({ data: { items: messages } })
  ),
  http.post("/api/build/build_get_conversation_ownership", () =>
    HttpResponse.json({
      data: {
        mode: "human",
        ownerUserId: "storybook-user",
        canReply: true,
        canTakeover: false,
      },
    })
  ),
  ...["build_list_ticket_notes", "build_list_macros"].map((operation) =>
    http.post(`/api/build/${operation}`, () => HttpResponse.json({ data: [] }))
  ),
  ...storybookAuthHandlers,
  ...workspaceProjectHandlers(),
]

const meta = {
  title: "Build/Inbox",
  component: InboxPage,
  parameters: {
    layout: "fullscreen",
    nextjs: { navigation: { pathname: "/p/demo/build/inbox" } },
    msw: { handlers },
  },
  decorators: [
    (Story) => (
      <ProjectScopeProvider
        projectId="storybook-project"
        organizationId={storybookOrganization.id}
        prefix="/p/demo"
      >
        <div className="h-screen">
          <TracerAppShell
            buildEnabled
            organization={storybookOrganization}
            project={{
              id: "storybook-project",
              name: "Shopify sandbox",
              slug: "demo",
            }}
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
    const original = useSearchParams.getMockImplementation()
    const url = new URL(window.location.href)
    for (const key of ["ticket", "status", "view", "q"])
      url.searchParams.delete(key)
    window.history.replaceState(null, "", url)
    const push = window.history.pushState,
      replace = window.history.replaceState
    window.history.pushState = function (...args) {
      push.apply(this, args)
      window.dispatchEvent(new PopStateEvent("popstate"))
    }
    window.history.replaceState = function (...args) {
      replace.apply(this, args)
      window.dispatchEvent(new PopStateEvent("popstate"))
    }
    useSearchParams.mockImplementation(function useBrowserSearchParams() {
      const search = useSyncExternalStore(
        subscribeBrowserNavigation,
        () => window.location.search,
        () => ""
      )
      return new ReadonlyURLSearchParams(search)
    })
    return () => {
      window.history.pushState = push
      window.history.replaceState = replace
      if (original) useSearchParams.mockImplementation(original)
    }
  },
} satisfies Meta<typeof InboxPage>
export default meta
type Story = StoryObj<typeof meta>

export const Desktop: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getAllByRole("textbox", { name: "Search conversations" })
    ).toHaveLength(1)
    const waiting = await canvas.findByRole("button", {
      name: /Open Quero falar.*needs takeover/,
    })
    await expect(within(waiting).getByText("Needs takeover")).toBeVisible()
    const handled = await canvas.findByRole("button", {
      name: "Open Marina Costa",
    })
    await expect(within(handled).queryByText("Needs takeover")).toBeNull()
    const queues = within(
      await canvas.findByRole("group", { name: "Inbox queues" })
    )
    await userEvent.click(queues.getByRole("button", { name: "Unassigned" }))
    await expect(
      canvas.findByRole("button", { name: "Open Vinicius Pacheco" })
    ).resolves.toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: "Open Marina Costa" })
    ).not.toBeInTheDocument()
    await userEvent.click(queues.getByRole("button", { name: "Open" }))
    const row = await canvas.findByRole("button", { name: "Open Marina Costa" })
    row.focus()
    await userEvent.keyboard("{Enter}")
    const page = within(canvasElement.ownerDocument.body)
    await expect(
      page.findByRole("heading", { name: "Marina Costa" })
    ).resolves.toBeVisible()
    const composer = await page.findByRole("textbox", {
      name: "Message",
    })
    await waitFor(() => expect(composer).toBeEnabled())
    const humanReply = page.getByRole("article", {
      name: "Ana Martins message",
    })
    await expect(within(humanReply).getByText("Ana Martins")).toBeVisible()
    await expect(
      humanReply.querySelector('[data-slot="user-avatar"]')
    ).toBeVisible()
    await userEvent.type(composer, "Let me check that for you.")
    await userEvent.click(
      page.getByRole("button", { name: "Conversation actions" })
    )
    await expect(
      page.getByRole("menuitem", { name: "Resume AI" })
    ).toBeEnabled()
    await expect(
      page.getByRole("menuitem", { name: "Refresh conversation" })
    ).toBeVisible()
    await userEvent.keyboard("{Escape}")
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(
      "Let me check that for you."
    )
    await userEvent.click(page.getByRole("tab", { name: "Notes" }))
    await userEvent.keyboard("{ArrowRight}")
    await expect(page.getByRole("tab", { name: "Details" })).toHaveFocus()
    await expect(page.getByRole("tabpanel", { name: "Details" })).toBeVisible()
    await userEvent.click(page.getByRole("tab", { name: "Conversation" }))
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(
      "Let me check that for you."
    )
    await userEvent.click(
      page.getByRole("button", { name: "Close conversation" })
    )
    await expect(row).toHaveFocus()
    await userEvent.keyboard("{Enter}")
    await expect(
      page.findByRole("heading", { name: "Marina Costa" })
    ).resolves.toBeVisible()
  },
}
export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post("/api/build/build_list_tickets", () =>
          HttpResponse.json({ data: { items: [], nextCursor: null } })
        ),
        ...handlers,
      ],
    },
  },
}
export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post("/api/build/build_list_tickets", async () => {
          await delay("infinite")
          return HttpResponse.json({ data: [] })
        }),
        ...handlers,
      ],
    },
  },
}
export const LoadError: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post("/api/build/build_list_tickets", () =>
          HttpResponse.json(
            {
              error: {
                message: "Could not load conversations. Please try again.",
              },
            },
            { status: 503 }
          )
        ),
        ...handlers,
      ],
    },
  },
}
