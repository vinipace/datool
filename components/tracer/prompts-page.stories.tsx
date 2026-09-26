import { checkCollectionSelection } from "../../.storybook/collection-panel-checks"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, spyOn, userEvent, waitFor, within } from "storybook/test"
import { delay, http, HttpResponse } from "msw"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import { modelProviderHandlers } from "../../.storybook/scenarios/model-providers"
import { defaultPrompt, type ManagedPrompt } from "@/src/lib/tracer/prompts"
import { NewPromptPage, PromptDetailPage, PromptsPage } from "./prompts-page"

const prompt: ManagedPrompt = {
  ...defaultPrompt,
  id: "prompt_support",
  name: "Support assistant",
  slug: "support-assistant",
  description: "Helpful, concise replies for the support team.",
  model: "openai/gpt-4.1-mini",
  messages: [
    {
      role: "system",
      content:
        "You are a friendly support assistant for {{company}}. Keep replies concise and ask a question when you need more context.",
    },
  ],
  revision: 2,
  version: null,
  publishedVersion: 2,
  publishedAt: "2026-09-17T11:00:00Z",
  hasDraft: false,
  createdAt: "2026-09-17T10:00:00Z",
  updatedAt: "2026-09-17T11:00:00Z",
}
const data = (value: unknown) => HttpResponse.json({ data: value })
const failure = (message: string) =>
  HttpResponse.json({ error: { message } }, { status: 500 })
const drafts = new Map<string, ManagedPrompt>()
const handlers = [
  ...modelProviderHandlers,
  http.get("/api/custom-views", () => data([])),
  http.get("/api/prompts", () => data([...drafts.values()])),
  http.get("/api/prompts/:id", ({ request, params }) => {
    const current = drafts.get(String(params.id)) ?? prompt
    return data(
      new URL(request.url).searchParams.get("version") === "1"
        ? { ...current, version: 1, description: "Original description" }
        : current
    )
  }),
  http.put("/api/prompts/:id", async ({ request, params }) => {
    const current = drafts.get(String(params.id)) ?? prompt
    const value = (await request.json()) as ManagedPrompt
    const next = {
      ...current,
      ...value,
      revision: current.revision + 1,
      hasDraft: true,
    }
    drafts.set(next.id, next)
    return data(next)
  }),
  http.post("/api/prompts", async ({ request }) => {
    const next = {
      ...((await request.json()) as ManagedPrompt),
      id: "prompt_created",
      revision: 1,
      version: null,
      publishedVersion: null,
      publishedAt: null,
      hasDraft: true,
      createdAt: prompt.createdAt,
      updatedAt: prompt.updatedAt,
    }
    drafts.set(next.id, next)
    return data(next)
  }),
  http.post("/api/prompts/:id/publish", ({ params }) => {
    const current = drafts.get(String(params.id))!
    const next = {
      ...current,
      revision: current.revision + 1,
      publishedVersion: (current.publishedVersion ?? 0) + 1,
      publishedAt: prompt.updatedAt,
      hasDraft: false,
    }
    drafts.set(next.id, next)
    return data(next)
  }),
  http.post("/api/prompts/test", async ({ request }) => {
    const value = (await request.json()) as {
      variables: Record<string, string>
    }
    if (value.variables.company !== "Datool")
      return failure("Missing company value")
    return data({
      role: "assistant",
      content: "Hello from Datool! How can I help?",
    })
  }),
]
const meta = {
  title: "Tracer/Prompts",
  component: PromptsPage,
  beforeEach: () => {
    drafts.clear()
    drafts.set(prompt.id, structuredClone(prompt))
  },
  parameters: {
    layout: "fullscreen",
    nextjs: { appDirectory: true, navigation: { pathname: "/p/demo/prompts" } },
    msw: { handlers },
  },
  render: () => (
    <StorybookProjectFrame title="Prompts">
      <PromptsPage />
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof PromptsPage>
export default meta
type Story = StoryObj<typeof meta>

export const Table: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("link", { name: "Support assistant" })
    ).resolves.toHaveAttribute("href", "/p/demo/prompts/prompt_support")
    await expect(
      canvas.getByRole("link", { name: "New prompt" })
    ).toHaveAttribute("href", "/p/demo/prompts/new")
  },
}
export const Empty: Story = {
  parameters: {
    msw: { handlers: [http.get("/api/prompts", () => data([])), ...handlers] },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("Create your first prompt")
    ).resolves.toBeVisible()
  },
}
export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/prompts", async () => {
          await delay("infinite")
          return data([])
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
        http.get("/api/prompts", () => failure("Unable to load prompts")),
        ...handlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("alert")
    ).resolves.toHaveTextContent("Unable to load prompts")
  },
}
export const New: Story = {
  parameters: { nextjs: { navigation: { pathname: "/p/demo/prompts/new" } } },
  render: () => (
    <StorybookProjectFrame
      title="New prompt"
      breadcrumbs={[{ label: "Prompts", href: "/p/demo/prompts" }]}
    >
      <NewPromptPage />
    </StorybookProjectFrame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.queryByRole("button", { name: "Save draft" })
    ).not.toBeInTheDocument()
    await userEvent.type(canvas.getByLabelText("Name"), "Support prompt")
    await expect(canvas.getByLabelText("Slug")).toHaveValue("support-prompt")
    const message = await canvas.findByRole(
      "textbox",
      { name: "Message 1" },
      { timeout: 10_000 }
    )
    await userEvent.click(message)
    const { monaco } = await import("./monaco-runtime")
    const editor = monaco.editor
      .getEditors()
      .find((editor) => editor.getDomNode()?.contains(message))!
    editor.trigger("storybook", "editor.action.selectAll", undefined)
    await userEvent.paste("Help the user.")
    await userEvent.click(canvas.getByRole("combobox", { name: "Model" }))
    await userEvent.click(
      within(await within(document.body).findByRole("group", { name: "Vercel AI Gateway" })).getByRole("option", { name: /GPT-4.1 mini/ })
    )
    await waitFor(
      () =>
        expect(drafts.get("prompt_created")).toMatchObject({
          model: "openai/gpt-4.1-mini",
          messages: [{ role: "system", content: "Help the user." }],
        }),
      { timeout: 5000 }
    )
    await expect(
      canvas.queryByRole("button", { name: "Save draft" })
    ).not.toBeInTheDocument()
    await expect(canvas.getByRole("button", { name: "Publish" })).toBeEnabled()
    await userEvent.click(canvas.getByRole("button", { name: "Publish" }))
    await waitFor(() =>
      expect(drafts.get("prompt_created")?.publishedVersion).toBe(1)
    )
    await expect(canvas.getByRole("button", { name: "Publish" })).toBeDisabled()
    await expect(canvas.getByLabelText("Slug")).toHaveAttribute("readonly")
  },
}
export const DirectOpenAI: Story = {
  ...New,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    await userEvent.type(canvas.getByLabelText("Name"), "OpenAI prompt")
    await userEvent.click(canvas.getByRole("combobox", { name: "Model" }))
    await userEvent.click(within(await page.findByRole("group", { name: "OpenAI" })).getByRole("option", { name: /GPT-4.1 mini/ }))
    await waitFor(() => expect(drafts.get("prompt_created")).toMatchObject({ provider: "openai", model: "gpt-4.1-mini" }))
    await userEvent.click(canvas.getByRole("button", { name: "Publish" }))
    await waitFor(() => expect(drafts.get("prompt_created")).toMatchObject({ provider: "openai", model: "gpt-4.1-mini", publishedVersion: 1 }))
  },
}

export const NewConversation: Story = {
  ...New,
  parameters: {
    ...New.parameters,
    msw: {
      handlers: [
        http.post("/api/prompts/test", async ({ request }) => {
          const value = (await request.json()) as {
            config: { messages: unknown[] }
            messages: unknown[]
          }
          if (
            JSON.stringify(value.config.messages) !==
            JSON.stringify([
              { role: "system", content: "you're helpful assistant" },
            ])
          )
            return failure("The default system prompt was not sent")
          await delay(200)
          return data({
            role: "assistant",
            content: value.messages.length === 1 ? "Hello!" : "Still here!",
          })
        }),
        ...handlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const originalUrl = window.location.href
    window.history.replaceState(null, "", "/p/demo/prompts/new")
    const replaceState = spyOn(window.history, "replaceState")
    try {
      await userEvent.type(canvas.getByLabelText("Name"), "Chat regression")
      await userEvent.click(canvas.getByRole("combobox", { name: "Model" }))
      await userEvent.click(
        within(await within(document.body).findByRole("group", { name: "Vercel AI Gateway" })).getByRole("option", { name: /GPT-4.1 mini/ })
      )
      await waitFor(() =>
        expect(drafts.get("prompt_created")).toMatchObject({
          model: "openai/gpt-4.1-mini",
          messages: [{ role: "system", content: "you're helpful assistant" }],
        })
      )
      await waitFor(() => expect(replaceState).toHaveBeenCalledTimes(1))
      await expect(replaceState).toHaveBeenCalledWith(
        null,
        "",
        "/p/demo/prompts/prompt_created"
      )
      const composer = canvas.getByRole("textbox", {
        name: "Message",
      })
      await userEvent.type(composer, "Hello{Enter}")
      await expect(
        canvas.findByText("Waiting for the agent…")
      ).resolves.toBeVisible()
      await expect(canvas.findByText("Hello!")).resolves.toBeVisible()
      await expect(composer).not.toHaveAttribute("readonly")
      await userEvent.type(composer, "Are you there?")
      await userEvent.click(
        canvas.getByRole("button", { name: "Send message" })
      )
      await expect(canvas.findByText("Still here!")).resolves.toBeVisible()
      await userEvent.click(
        canvas.getByRole("button", { name: "Clear conversation" })
      )
      await expect(canvas.getByText("Start a conversation")).toBeVisible()
      // Local edits and chat state must not write the same URL back into Next's router.
      await expect(replaceState).toHaveBeenCalledTimes(1)
    } finally {
      replaceState.mockRestore()
      window.history.replaceState(null, "", originalUrl)
    }
  },
}
export const Editor: Story = {
  parameters: {
    nextjs: { navigation: { pathname: "/p/demo/prompts/prompt_support" } },
  },
  render: () => (
    <StorybookProjectFrame
      title="Prompt details"
      breadcrumbs={[{ label: "Prompts", href: "/p/demo/prompts" }]}
    >
      <PromptDetailPage promptId={prompt.id} />
    </StorybookProjectFrame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const name = await canvas.findByLabelText("Name")
    await expect(
      canvas.queryByRole("button", { name: "Save draft" })
    ).not.toBeInTheDocument()
    await expect(canvas.getByRole("button", { name: "Publish" })).toBeDisabled()
    await userEvent.type(name, " edited")
    await expect(canvas.getByRole("button", { name: "Publish" })).toBeEnabled()
    await userEvent.clear(name)
    await userEvent.type(name, prompt.name)
    await expect(
      canvas.queryByRole("button", { name: "Save draft" })
    ).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("button", { name: "Variables (1)" }))
    await userEvent.type(canvas.getByLabelText("company"), "Datool")
    await userEvent.type(
      canvas.getByLabelText("Message", { selector: "textarea" }),
      "Hello"
    )
    // Variables is a toolbar action, never a submit button.
    await userEvent.click(canvas.getByRole("button", { name: "Variables (1)" }))
    await expect(
      canvas.queryByText("Hello from Datool! How can I help?")
    ).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("button", { name: "Send message" }))
    await expect(
      canvas.findByText("Hello from Datool! How can I help?")
    ).resolves.toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: "Prompt version" })
    )
    const menu = within(document.body)
    await expect(
      menu.getByRole("menuitemradio", { name: "Version 2 Published" })
    ).toBeVisible()
    await expect(
      menu.queryByRole("menuitemradio", { name: "Version 1 Published" })
    ).not.toBeInTheDocument()
    await userEvent.click(
      menu.getByRole("menuitemradio", { name: "Version 1" })
    )
    await expect(
      canvas.findByRole("button", { name: "Restore to draft" })
    ).resolves.toBeVisible()
    await expect(canvas.getByLabelText("Description")).toBeDisabled()
    await expect(drafts.get(prompt.id)?.description).toBe(prompt.description)
    await userEvent.click(
      canvas.getByRole("button", { name: "Restore to draft" })
    )
    await waitFor(
      () =>
        expect(drafts.get(prompt.id)?.description).toBe("Original description"),
      { timeout: 5000 }
    )
    await userEvent.click(canvas.getByRole("button", { name: "Publish" }))
    await waitFor(() => expect(drafts.get(prompt.id)?.publishedVersion).toBe(3))
    await expect(canvas.getByRole("button", { name: "Publish" })).toBeDisabled()
    await userEvent.click(
      canvas.getByRole("button", { name: "Prompt version" })
    )
    await expect(
      menu.getByRole("menuitemradio", { name: "Version 3 Published" })
    ).toBeVisible()
    await expect(
      menu.queryByRole("menuitemradio", { name: "Version 2 Published" })
    ).not.toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
  },
}
export const NarrowEditor: Story = {
  ...Editor,
  render: () => (
    <div className="w-[390px] max-w-full">
      <StorybookProjectFrame title="Prompt details">
        <PromptDetailPage promptId={prompt.id} />
      </StorybookProjectFrame>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByLabelText("Name")).resolves.toBeVisible()
    const header = canvas.getByRole("banner", { name: "Page controls" })
    await expect(
      within(header).getByRole("button", { name: "Prompt version" })
    ).toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: "Save draft" })
    ).not.toBeInTheDocument()
  },
}

export const MetadataAndTemperature: Story = {
  ...Editor,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const temperature = await canvas.findByRole("spinbutton", {
      name: "Temperature",
    })
    const slider = canvas.getByRole("slider", { name: "Temperature slider" })
    await expect(temperature).toHaveValue(null)
    await userEvent.type(temperature, "0.7")
    await expect(slider).toHaveAttribute("aria-valuenow", "0.7")
    await userEvent.clear(temperature)
    await expect(
      canvas.queryByRole("button", { name: "Save draft" })
    ).not.toBeInTheDocument()
    slider.focus()
    await userEvent.keyboard("{Home}{ArrowRight}")
    await expect(temperature).toHaveValue(0.1)

    const metadata = await canvas.findByRole(
      "textbox",
      { name: "Metadata" },
      { timeout: 10_000 }
    )
    const { monaco } = await import("./monaco-runtime")
    const editor = monaco.editor
      .getEditors()
      .find((item) => item.getDomNode()?.contains(metadata))!
    await userEvent.click(metadata)
    editor.trigger("storybook", "editor.action.selectAll", undefined)
    await userEvent.paste("[]")
    await expect(
      canvas.findByText("Enter a valid JSON object.")
    ).resolves.toBeVisible()
    editor.trigger("storybook", "editor.action.selectAll", undefined)
    await waitFor(() => expect(editor.getSelection()?.isEmpty()).toBe(false))
    await userEvent.paste('{"team":"support","priority":2}')
    await waitFor(() =>
      expect(
        canvas.queryByText("Enter a valid JSON object.")
      ).not.toBeInTheDocument()
    )
    await waitFor(
      () =>
        expect(drafts.get(prompt.id)?.metadata).toEqual({
          team: "support",
          priority: 2,
        }),
      { timeout: 5000 }
    )
    await expect(
      canvas.queryByRole("button", { name: "Save draft" })
    ).not.toBeInTheDocument()
  },
}
export const SaveError: Story = {
  ...Editor,
  parameters: {
    msw: {
      handlers: [
        http.put("/api/prompts/:id", () =>
          failure("This prompt changed. Reload before saving.")
        ),
        ...handlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(await canvas.findByLabelText("Name"), " edited")
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "This prompt changed"
    )
    await expect(canvas.getByLabelText("Name")).toHaveValue(
      `${prompt.name} edited`
    )
  },
}

export const EditorLoading: Story = {
  ...Editor,
  parameters: {
    msw: {
      handlers: [
        http.get("/api/prompts/:id", async () => {
          await delay("infinite")
          return data(prompt)
        }),
        ...handlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("status", { name: "Loading prompt" })
    ).resolves.toBeVisible()
  },
}

export const IncompleteDraft: Story = {
  ...New,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByLabelText("Name"), "Work in progress")
    await waitFor(
      () => expect(drafts.get("prompt_created")?.name).toBe("Work in progress"),
      { timeout: 5000 }
    )
    await expect(
      canvas.queryByRole("button", { name: "Save draft" })
    ).not.toBeInTheDocument()
    await expect(canvas.getByRole("button", { name: "Publish" })).toBeDisabled()
    await expect(
      canvas.queryByLabelText("Prompt version")
    ).not.toBeInTheDocument()
  },
}

export const PublishError: Story = {
  ...Editor,
  parameters: {
    msw: {
      handlers: [
        http.post("/api/prompts/:id/publish", () =>
          failure("This prompt changed. Reload before publishing.")
        ),
        ...handlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(await canvas.findByLabelText("Name"), " edited")
    await waitFor(
      () =>
        expect(drafts.get(prompt.id)?.name).toBe("Support assistant edited"),
      { timeout: 5000 }
    )
    await userEvent.click(canvas.getByRole("button", { name: "Publish" }))
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "This prompt changed."
    )
    await expect(canvas.getByLabelText("Name")).toHaveValue(
      "Support assistant edited"
    )
    await expect(canvas.getByRole("button", { name: "Publish" })).toBeEnabled()
  },
}

export const SelectionHeader: Story = {
  ...Table,
  play: async ({ canvasElement }) => checkCollectionSelection(canvasElement, "Prompts"),
}
