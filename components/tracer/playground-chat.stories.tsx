import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  getRouter,
  ReadonlyURLSearchParams,
  useSearchParams,
} from "@storybook/nextjs-vite/navigation.mock"
import { http } from "msw"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import {
  data,
  failure,
} from "../../.storybook/scenarios/datasets-evals/handlers"
import {
  supportApp,
  traceDetail,
} from "../../.storybook/scenarios/datasets-evals/fixtures"
import { PlaygroundAppPage } from "./playground-page"
import type { JsonValue } from "@/src/lib/tracer/contracts"

const agent = {
  ...supportApp,
  name: "Weather agent",
  mode: "agent" as const,
  inputSchema: {
    type: "object",
    properties: {
      messages: {
        type: "array",
        items: {
          type: "object",
          properties: { role: { type: "string" }, content: { type: "string" } },
        },
      },
    },
  },
  defaultInput: { messages: [] },
}
const saved = {
  ...traceDetail,
  id: "saved-chat",
  name: "Weather run",
  spans: [],
  input: { messages: [{ role: "user", content: "São Paulo?" }] },
  output: { content: "Sunny in São Paulo." },
  attributes: {
    "datool.connection.id": agent.id,
    "datool.call.id": "saved-call",
  },
}
let submissions: JsonValue[] = []
let finish: ((response: Response) => void) | undefined
let latest = saved
function navigation(run = "") {
  const previous = useSearchParams.getMockImplementation()
  const router = getRouter()
  useSearchParams.mockReturnValue(
    new ReadonlyURLSearchParams(run ? `run=${run}` : "")
  )
  router.replace.mockImplementation((href: string) => {
    useSearchParams.mockReturnValue(
      new ReadonlyURLSearchParams(
        new URL(href, "http://localhost").searchParams
      )
    )
  })
  return () => {
    if (previous) useSearchParams.mockImplementation(previous)
    router.replace.mockReset()
  }
}
const readHandlers = [
  http.get("/api/evaluators", () => data({ items: [], nextCursor: null })),
  http.get("/api/traces/:id/scores", () =>
    data({ items: [], nextCursor: null })
  ),
  http.get("/api/apps/config", () => data([agent])),
  http.get("/api/traces/:id/payload", () => data(latest)),
  http.get("/api/traces", () => data({ items: [latest], nextCursor: null })),
  http.get("/api/traces/:id/overview", () => data(latest)),
]
const meta = {
  title: "Tracer/Playground/Chat",
  component: PlaygroundAppPage,
  args: { appId: agent.id },
  parameters: {
    layout: "fullscreen",
    nextjs: {
      navigation: { pathname: `/p/demo/playground/${agent.id}`, query: {} },
    },
    msw: { handlers: readHandlers },
  },
  beforeEach: () => {
    localStorage.removeItem("datool:playground:inspector-tab")
    submissions = []
    finish = undefined
    latest = saved
    const resetNavigation = navigation()
    return () => {
      resetNavigation()
      localStorage.removeItem("datool:playground:inspector-tab")
    }
  },
  render: (args) => (
    <StorybookProjectFrame>
      <PlaygroundAppPage {...args} />
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof PlaygroundAppPage>
export default meta
type Story = StoryObj<typeof meta>

async function openChat(canvasElement: HTMLElement) {
  const canvas = within(canvasElement)
  await userEvent.selectOptions(
    await canvas.findByRole("combobox", { name: "Input format" }),
    "chat"
  )
  return canvas
}

export const Conversation: Story = {
  parameters: {
    msw: {
      handlers: [
        ...readHandlers,
        http.post("/api/apps/:id/runs", async ({ request }) => {
          const input = (await request.json()) as typeof saved.input
          submissions.push(input)
          latest = {
            ...saved,
            id: `chat-${submissions.length}`,
            input,
            output: {
              content:
                submissions.length === 1
                  ? "Sunny in São Paulo."
                  : "Sunny in both cities.",
            },
          }
          return new Promise<Response>((resolve) => {
            finish = resolve
          })
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = await openChat(canvasElement)
    await expect(canvas.getByText("Start a conversation")).toBeVisible()
    const send = canvas.getByRole("button", { name: "Send message" })
    await expect(send).toBeDisabled()
    const composer = canvas.getByRole("textbox", {
      name: "Message",
    })
    await userEvent.type(composer, "São Paulo?")
    await userEvent.keyboard("{Enter}")
    await waitFor(() =>
      expect(submissions).toEqual([
        { messages: [{ role: "user", content: "São Paulo?" }] },
      ])
    )
    await expect(canvas.getByText("Waiting for the agent…")).toBeVisible()
    await expect(send).toBeDisabled()
    finish!(
      data({ traceId: latest.id, status: "completed", output: latest.output })
    )
    const conversation = within(
      canvas.getByRole("log", { name: "Conversation" })
    )
    await expect(
      conversation.findByText("Sunny in São Paulo.")
    ).resolves.toBeVisible()
    await canvas.findByRole("heading", { name: "Weather run" })
    await expect(send).toBeDisabled()
    await userEvent.type(composer, "And Rio?")
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}")
    await userEvent.type(composer, "Compare them.")
    await expect(composer).toHaveValue("And Rio?\nCompare them.")
    await expect(submissions).toHaveLength(1)
    await userEvent.click(send)
    await waitFor(() => expect(submissions).toHaveLength(2))
    await expect(submissions[1]).toEqual({
      messages: [
        { role: "user", content: "São Paulo?" },
        { role: "assistant", content: "Sunny in São Paulo." },
        { role: "user", content: "And Rio?\nCompare them." },
      ],
    })
    await expect(
      getComputedStyle(
        canvasElement.querySelector('[data-slot="playground-run-traces"]')!
      ).filter
    ).toMatch(/blur/)
    finish!(
      data({ traceId: latest.id, status: "completed", output: latest.output })
    )
    await expect(
      conversation.findByText("Sunny in both cities.")
    ).resolves.toBeVisible()
    await waitFor(() =>
      expect(
        getComputedStyle(
          canvasElement.querySelector('[data-slot="playground-run-traces"]')!
        ).filter
      ).toBe("none")
    )
    await userEvent.type(composer, "Unsent draft")
    for (const format of ["json", "yaml", "form", "chat"]) {
      await userEvent.selectOptions(
        canvas.getByRole("combobox", { name: "Input format" }),
        format
      )
    }
    await expect(canvas.getByRole("textbox", { name: "Message" })).toHaveValue(
      "Unsent draft"
    )
    await expect(
      canvas.getByRole("log").querySelectorAll("article")
    ).toHaveLength(4)
  },
}

export const RetryFailedTurn: Story = {
  parameters: {
    msw: {
      handlers: [
        ...readHandlers,
        http.post("/api/apps/:id/runs", async ({ request }) => {
          const input = (await request.json()) as typeof saved.input
          submissions.push(input)
          if (submissions.length === 1) return failure("Listener disconnected")
          latest = { ...saved, id: "retried", input }
          return data({
            traceId: latest.id,
            status: "completed",
            output: latest.output,
          })
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = await openChat(canvasElement)
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Message" }),
      "São Paulo?"
    )
    await userEvent.click(canvas.getByRole("button", { name: "Send message" }))
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Listener disconnected"
    )
    await expect(
      canvas.getByRole("log").querySelectorAll("article")
    ).toHaveLength(1)
    await userEvent.click(canvas.getByRole("button", { name: "Send message" }))
    await expect(
      within(canvas.getByRole("log")).findByText("Sunny in São Paulo.")
    ).resolves.toBeVisible()
    await expect(submissions).toHaveLength(2)
    await expect(submissions[1]).toEqual(submissions[0])
    await expect(
      canvas.getByRole("log").querySelectorAll("article")
    ).toHaveLength(2)
  },
}

export const ResumeSavedRun: Story = {
  beforeEach: () => navigation(saved.id),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("heading", { name: "Weather run" })
    await openChat(canvasElement)
    await expect(canvas.getByRole("log")).toHaveTextContent("São Paulo?")
    await expect(canvas.getByRole("log")).toHaveTextContent(
      "Sunny in São Paulo."
    )
    for (const format of ["json", "chat", "yaml", "chat"])
      await userEvent.selectOptions(
        canvas.getByRole("combobox", { name: "Input format" }),
        format
      )
    await expect(
      canvas.getByRole("log").querySelectorAll("article")
    ).toHaveLength(2)
    await expect(
      canvas.getByRole("button", { name: "Send message" })
    ).toBeDisabled()
  },
}

export const InvalidMessages: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/apps/config", () =>
          data([{ ...agent, defaultInput: { messages: "invalid" } }])
        ),
        ...readHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = await openChat(canvasElement)
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      "Chat requires messages"
    )
    await expect(
      canvas.getByRole("button", { name: "Send message" })
    ).toBeDisabled()
    await userEvent.selectOptions(
      canvas.getByRole("combobox", { name: "Input format" }),
      "json"
    )
    await expect(
      canvas.findByRole("textbox", { name: "JSON input" }, { timeout: 10000 })
    ).resolves.toBeVisible()
  },
}

export const Offline: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/apps/config", () => data([{ ...agent, online: false }])),
        ...readHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = await openChat(canvasElement)
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Message" }),
      "Hello"
    )
    await expect(
      canvas.getByRole("button", { name: "Send message" })
    ).toBeDisabled()
    await expect(canvas.getByRole("button", { name: "Run" })).toBeDisabled()
  },
}
