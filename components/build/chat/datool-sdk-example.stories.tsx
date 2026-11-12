import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { http, HttpResponse } from "msw"
import Page from "@/examples/react-agent/app/page"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
let workspace = "acme"
let polls = 0
let failedLoad = false
let heldPoll: ReturnType<typeof deferred> | null = null
let heldSwitch: ReturnType<typeof deferred> | null = null
const snapshot = (scope: string) => ({
  workspace: scope,
  content: `${scope} saved company context`,
  tasks: [],
})
const meta = {
  title: "Build/DatoolSdkExample",
  component: Page,
  beforeEach: () => {
    workspace = "acme"
    polls = 0
    failedLoad = false
    heldPoll = null
    heldSwitch = null
  },
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/demo", async () => {
          const data = snapshot(workspace)
          polls++
          await heldPoll?.promise
          return HttpResponse.json(data)
        }),
        http.post("*/api/demo", async ({ request }) => {
          const body = (await request.json()) as {
            action: string
            workspace?: string
          }
          if (body.action === "workspace") {
            await heldSwitch?.promise
            workspace = body.workspace!
            return HttpResponse.json({ ok: true })
          }
          if (body.action === "load" && failedLoad)
            return HttpResponse.json(
              { error: "Drive unavailable" },
              { status: 503 }
            )
          return HttpResponse.json(snapshot(workspace))
        }),
        http.post("*/api/datool", async ({ request }) => {
          const body = (await request.json()) as {
            action: string
            conversationId?: string
          }
          if (body.action === "session")
            return HttpResponse.json({ data: { conversationId: workspace } })
          if (body.conversationId !== workspace)
            return HttpResponse.json(
              { error: { message: "Wrong workspace" } },
              { status: 404 }
            )
          return HttpResponse.json({
            data: {
              conversationId: workspace,
              messages: [
                {
                  id: workspace,
                  role: "assistant",
                  text: `${workspace} saved conversation`,
                  createdAt: new Date().toISOString(),
                },
              ],
              pending: false,
              failed: false,
              nextCursor: null,
            },
          })
        }),
      ],
    },
  },
} satisfies Meta<typeof Page>
export default meta
type Story = StoryObj<typeof meta>

export const SwitchWaitsForContextAndIgnoresOldRefresh: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const editor = canvas.getByRole("textbox", { name: /context\/company.md/ })
    await waitFor(() =>
      expect(editor).toHaveValue("acme saved company context")
    )
    await expect(
      canvas.findByText("acme saved conversation")
    ).resolves.toBeVisible()
    heldPoll = deferred()
    heldSwitch = deferred()
    try {
      await waitFor(() => expect(polls).toBeGreaterThan(0), { timeout: 7000 })
      await userEvent.selectOptions(canvas.getByRole("combobox"), "orbit")
      await expect(editor).toBeDisabled()
      await expect(editor).toHaveValue("")
      await expect(
        canvas.queryByText("acme saved conversation")
      ).not.toBeInTheDocument()
      heldSwitch.resolve()
      await waitFor(() =>
        expect(editor).toHaveValue("orbit saved company context")
      )
      await expect(
        canvas.findByText("orbit saved conversation")
      ).resolves.toBeVisible()
      heldPoll.resolve()
      // The old response completes after Orbit is loaded; it must stay discarded.
      await userEvent.click(
        canvas.getByRole("tab", { name: /Scheduled tasks/ })
      )
      await userEvent.click(
        canvas.getByRole("tab", { name: "Drive & context" })
      )
      await expect(
        canvas.getByRole("textbox", { name: /context\/company.md/ })
      ).toHaveValue("orbit saved company context")
      await expect(canvas.getByRole("combobox")).toHaveValue("orbit")
      await userEvent.selectOptions(canvas.getByRole("combobox"), "acme")
      await waitFor(() =>
        expect(
          canvas.getByRole("textbox", { name: /context\/company.md/ })
        ).toHaveValue("acme saved company context")
      )
      await expect(
        canvas.findByText("acme saved conversation")
      ).resolves.toBeVisible()
      await expect(
        canvas.queryByText("orbit saved conversation")
      ).not.toBeInTheDocument()
    } finally {
      heldPoll.resolve()
      heldSwitch.resolve()
    }
  },
}

export const TaskRefreshPreservesDraft: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const editor = canvas.getByRole("textbox", { name: /context\/company.md/ })
    await waitFor(() => expect(editor).toBeEnabled())
    await userEvent.clear(editor)
    await userEvent.type(editor, "My unsaved company draft")
    await waitFor(() => expect(polls).toBeGreaterThan(0), { timeout: 7000 })
    await expect(editor).toHaveValue("My unsaved company draft")
    await expect(canvas.getByText("Unsaved changes")).toBeVisible()
  },
}

export const FailedLoadKeepsChatClosedAndCanRetry: Story = {
  beforeEach: () => {
    failedLoad = true
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const retry = await canvas.findByRole("button", {
      name: "Retry loading workspace",
    })
    await expect(
      canvas.getByRole("textbox", { name: /context\/company.md/ })
    ).toBeDisabled()
    await expect(
      canvas.queryByRole("textbox", { name: "Message" })
    ).not.toBeInTheDocument()
    failedLoad = false
    await userEvent.click(retry)
    await waitFor(() =>
      expect(
        canvas.getByRole("textbox", { name: /context\/company.md/ })
      ).toHaveValue("acme saved company context")
    )
    await expect(
      canvas.findByText("acme saved conversation")
    ).resolves.toBeVisible()
  },
}
