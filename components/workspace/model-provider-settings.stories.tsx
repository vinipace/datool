import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { delay, http, HttpResponse } from "msw"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { OPENAI_PROVIDER, TYPESAFE_PROVIDER, type ModelProvider } from "@/src/lib/model-providers"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import {
  providerStatus,
  modelProviderHandlers,
} from "../../.storybook/scenarios/model-providers"
import { ModelProviderSettings } from "./model-provider-settings"

const path = "/api/projects/provider-test/providers"
let configured = false
let typesafeConfigured = false
let openaiConfigured = false
const mutations = fn()
const meta = {
  title: "Workspace/ModelProviderSettings",
  component: ModelProviderSettings,
  args: { projectId: "provider-test", canManage: true },
  beforeEach: () => {
    configured = false
    typesafeConfigured = false
    openaiConfigured = false
    mutations.mockClear()
  },
  parameters: {
    msw: {
      handlers: [
        modelProviderHandlers[0],
        http.get(path, () => HttpResponse.json(providerStatus(configured, typesafeConfigured, openaiConfigured))),
        http.put(path, async ({ request }) => {
          const body = (await request.json()) as { apiKey: string; provider: ModelProvider }
          if (!body.apiKey)
            return HttpResponse.json(
              { error: { message: "API key required." } },
              { status: 400 }
            )
          mutations("PUT", body)
          if (body.provider === TYPESAFE_PROVIDER) typesafeConfigured = true
          else if (body.provider === OPENAI_PROVIDER) openaiConfigured = true
          else configured = true
          return HttpResponse.json(providerStatus(configured, typesafeConfigured, openaiConfigured))
        }),
        http.delete(path, async ({ request }) => {
          const body = await request.json() as { provider: ModelProvider }
          mutations("DELETE", body)
          if (body.provider === TYPESAFE_PROVIDER) typesafeConfigured = false
          else if (body.provider === OPENAI_PROVIDER) openaiConfigured = false
          else configured = false
          return HttpResponse.json(providerStatus(configured, typesafeConfigured, openaiConfigured))
        }),
      ],
    },
  },
  render: (args) => (
    <StorybookProjectFrame title="AI providers">
      <ModelProviderSettings {...args} />
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof ModelProviderSettings>
export default meta
type Story = StoryObj<typeof meta>

async function expectClosed() {
  await waitFor(() =>
    expect(within(document.body).queryByRole("dialog")).not.toBeInTheDocument()
  )
}
async function openGateway(canvasElement: HTMLElement) {
  await userEvent.click(
    within(canvasElement).getByRole("button", { name: "Add provider" })
  )
  const dialog = within(await within(document.body).findByRole("dialog"))
  await userEvent.click(
    dialog.getByRole("button", { name: "Vercel AI Gateway" })
  )
  return dialog
}
export const SaveReplaceRemove: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(/No AI providers configured/)
    const dialog = await openGateway(canvasElement)
    const input = dialog.getByLabelText("AI Gateway API key")
    await expect(input).toHaveAttribute("type", "password")
    await expect(
      dialog.getByRole("button", { name: "Add provider" })
    ).toBeDisabled()
    await userEvent.type(input, "test-only-key")
    await userEvent.click(dialog.getByRole("button", { name: "Add provider" }))
    await expectClosed()
    await canvas.findByText("Vercel AI Gateway")
    await userEvent.click(
      canvas.getByRole("button", { name: "Edit Vercel AI Gateway" })
    )
    const edit = within(await within(document.body).findByRole("dialog"))
    await expect(edit.getByLabelText("AI Gateway API key")).toHaveValue("")
    const save = edit.getByRole("button", { name: "Save changes" })
    await expect(save).toBeDisabled()
    await userEvent.type(
      edit.getByLabelText("AI Gateway API key"),
      "test-only-replacement"
    )
    await expect(save).toBeEnabled()
    await userEvent.clear(edit.getByLabelText("AI Gateway API key"))
    await expect(save).toBeDisabled()
    await userEvent.type(
      edit.getByLabelText("AI Gateway API key"),
      "test-only-replacement"
    )
    await userEvent.click(save)
    await expectClosed()
    await userEvent.click(
      canvas.getByRole("button", { name: "Remove Vercel AI Gateway" })
    )
    await userEvent.click(
      within(await within(document.body).findByRole("dialog")).getByRole(
        "button",
        { name: "Cancel" }
      )
    )
    await expectClosed()
    await userEvent.click(
      canvas.getByRole("button", { name: "Remove Vercel AI Gateway" })
    )
    await userEvent.click(
      within(await within(document.body).findByRole("dialog")).getByRole(
        "button",
        { name: "Confirm removal" }
      )
    )
    await expectClosed()
    await canvas.findByText(/No AI providers configured/)
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "API key removed"
    )
  },
}
export const Configured: Story = {
  beforeEach: () => {
    configured = true
  },
}
export const TypeSafeSaveReplaceRemove: Story = {
  beforeEach: () => { configured = true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(document.body)
    await canvas.findByText("Vercel AI Gateway")
    await userEvent.click(canvas.getByRole("button", { name: "Add provider" }))
    let dialog = within(await page.findByRole("dialog"))
    await userEvent.click(dialog.getByRole("button", { name: "TypeSafe AI" }))
    const key = dialog.getByLabelText("TypeSafe AI API key")
    await expect(key).toHaveAttribute("type", "password")
    await expect(key).toHaveValue("")
    await userEvent.type(key, "test-typesafe-key")
    await userEvent.click(dialog.getByRole("button", { name: "Add provider" }))
    await expectClosed()
    await expect(mutations).toHaveBeenLastCalledWith("PUT", { provider: TYPESAFE_PROVIDER, apiKey: "test-typesafe-key" })
    await expect(canvas.getByText("TypeSafe AI")).toBeVisible()
    await expect(canvas.getByText("Vercel AI Gateway")).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Edit TypeSafe AI" }))
    dialog = within(await page.findByRole("dialog"))
    await expect(dialog.getByLabelText("TypeSafe AI API key")).toHaveValue("")
    await userEvent.type(dialog.getByLabelText("TypeSafe AI API key"), "test-typesafe-replacement")
    await userEvent.click(dialog.getByRole("button", { name: "Save changes" }))
    await expectClosed()
    await expect(mutations).toHaveBeenLastCalledWith("PUT", { provider: TYPESAFE_PROVIDER, apiKey: "test-typesafe-replacement" })
    await userEvent.click(canvas.getByRole("button", { name: "Remove TypeSafe AI" }))
    dialog = within(await page.findByRole("dialog"))
    await expect(dialog.getByRole("heading")).toHaveTextContent("Remove TypeSafe AI?")
    await userEvent.click(dialog.getByRole("button", { name: "Confirm removal" }))
    await expectClosed()
    await expect(mutations).toHaveBeenLastCalledWith("DELETE", { provider: TYPESAFE_PROVIDER })
    await expect(canvas.queryByText("TypeSafe AI", { exact: true })).not.toBeInTheDocument()
    await expect(canvas.getByText("Vercel AI Gateway")).toBeVisible()
  },
}
export const OpenAISaveReplaceRemove: Story = {
  beforeEach: () => { configured = true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(document.body)
    await canvas.findByText("Vercel AI Gateway")
    await userEvent.click(canvas.getByRole("button", { name: "Add provider" }))
    let dialog = within(await page.findByRole("dialog"))
    await userEvent.click(dialog.getByRole("button", { name: "OpenAI" }))
    const key = dialog.getByLabelText("OpenAI API key")
    await expect(key).toHaveAttribute("type", "password")
    await expect(key).toHaveValue("")
    await userEvent.type(key, "test-openai-key")
    await userEvent.click(dialog.getByRole("button", { name: "Add provider" }))
    await expectClosed()
    await expect(mutations).toHaveBeenLastCalledWith("PUT", { provider: OPENAI_PROVIDER, apiKey: "test-openai-key" })
    await expect(canvas.getByText("OpenAI")).toBeVisible()
    await expect(canvas.getByText("Vercel AI Gateway")).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Edit OpenAI" }))
    dialog = within(await page.findByRole("dialog"))
    await expect(dialog.getByLabelText("OpenAI API key")).toHaveValue("")
    await userEvent.type(dialog.getByLabelText("OpenAI API key"), "test-openai-replacement")
    await userEvent.click(dialog.getByRole("button", { name: "Save changes" }))
    await expectClosed()
    await expect(mutations).toHaveBeenLastCalledWith("PUT", { provider: OPENAI_PROVIDER, apiKey: "test-openai-replacement" })
    await userEvent.click(canvas.getByRole("button", { name: "Remove OpenAI" }))
    dialog = within(await page.findByRole("dialog"))
    await expect(dialog.getByRole("heading")).toHaveTextContent("Remove OpenAI?")
    await userEvent.click(dialog.getByRole("button", { name: "Confirm removal" }))
    await expectClosed()
    await expect(mutations).toHaveBeenLastCalledWith("DELETE", { provider: OPENAI_PROVIDER })
    await expect(canvas.queryByText("OpenAI", { exact: true })).not.toBeInTheDocument()
    await expect(canvas.getByText("Vercel AI Gateway")).toBeVisible()
  },
}
export const AllProviders: Story = {
  beforeEach: () => { configured = true; typesafeConfigured = true; openaiConfigured = true },
}
export const ProviderPicker: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(/No AI providers configured/)
    await userEvent.click(canvas.getByRole("button", { name: "Add provider" }))
    await expect(within(document.body).getByRole("dialog")).toHaveTextContent(
      "Add AI provider"
    )
  },
}
export const Empty: Story = {}
export const MemberReadOnly: Story = {
  args: { canManage: false },
  beforeEach: () => {
    configured = true
    typesafeConfigured = true
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Vercel AI Gateway")
    await canvas.findByText("TypeSafe AI")
    await expect(
      canvas.queryByRole("button", { name: "Add provider" })
    ).not.toBeInTheDocument()
    await expect(
      canvas.queryByRole("button", { name: /Edit|Remove/ })
    ).not.toBeInTheDocument()
  },
}
export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get(path, async () => {
          await delay("infinite")
          return HttpResponse.json(providerStatus())
        }),
      ],
    },
  },
}
export const LoadError: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get(path, () =>
          HttpResponse.json(
            { error: { message: "Unable to load model providers." } },
            { status: 500 }
          )
        ),
      ],
    },
  },
}
export const SaveError: Story = {
  parameters: {
    msw: {
      handlers: [
        modelProviderHandlers[0],
        http.get(path, () => HttpResponse.json(providerStatus(false))),
        http.put(path, () =>
          HttpResponse.json(
            { error: { message: "Unable to update model provider settings." } },
            { status: 500 }
          )
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(/No AI providers configured/)
    const dialog = await openGateway(canvasElement)
    await userEvent.type(
      dialog.getByLabelText("AI Gateway API key"),
      "test-only-key"
    )
    await userEvent.click(dialog.getByRole("button", { name: "Add provider" }))
    await expect(dialog.findByRole("alert")).resolves.toHaveTextContent(
      "Unable to update"
    )
    await expect(dialog.getByLabelText("AI Gateway API key")).toHaveValue(
      "test-only-key"
    )
  },
}
