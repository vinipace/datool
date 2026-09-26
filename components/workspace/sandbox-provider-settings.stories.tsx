import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { delay, http, HttpResponse } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  sandboxExecutionOrder,
  sandboxProviderIds,
  type SandboxProviderSettings as Settings,
  type SandboxProviderId,
} from "@/src/lib/sandbox-providers"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import { modelProviderHandlers } from "../../.storybook/scenarios/model-providers"
import { SandboxProviderSettings } from "./sandbox-provider-settings"

const path = "/api/projects/sandbox-test/sandbox-providers"
const initial = (): Settings => ({
  providers: sandboxProviderIds.map((id) => ({
    id,
    configured: id === "local",
  })),
  defaultProvider: "local",
  executionOrder: ["local"],
})
let settings = initial()
const handlers = [
  modelProviderHandlers[0],
  http.get(path, () => HttpResponse.json(settings)),
  http.put(path, async ({ request }) => {
    const input = (await request.json()) as {
      provider: SandboxProviderId
      teamId?: string
      projectId?: string
    }
    settings.providers = settings.providers.map((provider) =>
      provider.id === input.provider
        ? {
            id: input.provider,
            configured: true,
            teamId: input.teamId,
            projectId: input.projectId,
          }
        : provider
    )
    settings.defaultProvider ??= input.provider
    settings.executionOrder = sandboxExecutionOrder(
      settings.providers
        .filter((provider) => provider.configured)
        .map((provider) => provider.id),
      settings.defaultProvider
    )
    return HttpResponse.json(settings)
  }),
  http.patch(path, async ({ request }) => {
    const { provider } = (await request.json()) as {
      provider: SandboxProviderId
    }
    settings.defaultProvider = provider
    settings.executionOrder = sandboxExecutionOrder(
      settings.providers
        .filter((provider) => provider.configured)
        .map((provider) => provider.id),
      provider
    )
    return HttpResponse.json(settings)
  }),
  http.delete(path, async ({ request }) => {
    const { provider } = (await request.json()) as {
      provider: SandboxProviderId
    }
    settings.providers = settings.providers.map((entry) =>
      entry.id === provider ? { id: provider, configured: false } : entry
    )
    const configured = settings.providers
      .filter((entry) => entry.configured)
      .map((entry) => entry.id)
    if (settings.defaultProvider === provider)
      settings.defaultProvider = configured[0] ?? null
    settings.executionOrder = sandboxExecutionOrder(
      configured,
      settings.defaultProvider
    )
    return HttpResponse.json(settings)
  }),
]
const meta = {
  title: "Workspace/SandboxProviderSettings",
  component: SandboxProviderSettings,
  args: { projectId: "sandbox-test", canManage: true },
  beforeEach: () => {
    settings = initial()
  },
  parameters: { msw: { handlers } },
  render: (args) => (
    <StorybookProjectFrame title="Sandbox providers">
      <SandboxProviderSettings {...args} />
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof SandboxProviderSettings>
export default meta
type Story = StoryObj<typeof meta>

async function openProvider(canvasElement: HTMLElement, name: string) {
  await userEvent.click(
    within(canvasElement).getByRole("button", { name: "Add provider" })
  )
  const dialog = within(await within(document.body).findByRole("dialog"))
  await userEvent.click(dialog.getByRole("button", { name }))
  return dialog
}
async function expectClosed() {
  await waitFor(() =>
    expect(within(document.body).queryByRole("dialog")).not.toBeInTheDocument()
  )
}

export const ConfigureDefaultAndRemove: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Local container")
    const vercel = await openProvider(canvasElement, "Vercel Sandbox")
    await userEvent.type(vercel.getByLabelText("API token"), "test-only-token")
    await userEvent.type(vercel.getByLabelText("Team ID"), "team_test")
    await userEvent.type(vercel.getByLabelText("Vercel project ID"), "prj_test")
    await userEvent.click(vercel.getByRole("button", { name: "Add provider" }))
    await expectClosed()
    await canvas.findByText("Vercel Sandbox")
    await userEvent.click(
      canvas.getByRole("button", { name: "Edit Vercel Sandbox" })
    )
    const edit = within(await within(document.body).findByRole("dialog"))
    await expect(edit.getByLabelText("API token")).toHaveValue("")
    const save = edit.getByRole("button", { name: "Save changes" })
    await expect(save).toBeDisabled()
    await userEvent.type(edit.getByLabelText("Team ID"), "x")
    await expect(save).toBeEnabled()
    await userEvent.type(edit.getByLabelText("Team ID"), "{Backspace}")
    await expect(save).toBeDisabled()
    await userEvent.click(edit.getByRole("button", { name: "Cancel" }))
    await expectClosed()
    await userEvent.click(
      canvas.getByRole("button", { name: "Make Vercel Sandbox default" })
    )
    await waitFor(() =>
      expect(
        canvas.getByRole("row", { name: /Vercel Sandbox/ })
      ).toHaveTextContent("Default")
    )
    const modal = await openProvider(canvasElement, "Modal")
    await userEvent.type(modal.getByLabelText("Token ID"), "modal-id")
    await userEvent.type(modal.getByLabelText("Token secret"), "modal-secret")
    await userEvent.click(modal.getByRole("button", { name: "Add provider" }))
    await expectClosed()
    await canvas.findByText("Modal")
    await userEvent.click(
      canvas.getByRole("button", { name: "Remove Vercel Sandbox" })
    )
    await userEvent.click(
      within(await within(document.body).findByRole("dialog")).getByRole(
        "button",
        { name: "Cancel" }
      )
    )
    await expectClosed()
    await userEvent.click(
      canvas.getByRole("button", { name: "Remove Vercel Sandbox" })
    )
    await userEvent.click(
      within(await within(document.body).findByRole("dialog")).getByRole(
        "button",
        { name: "Confirm removal" }
      )
    )
    await expectClosed()
    await expect(
      canvas.getByRole("row", { name: /Local container/ })
    ).toHaveTextContent("Default")
    await expect(canvas.queryByText("Vercel Sandbox")).not.toBeInTheDocument()
  },
}
export const LocalDefault: Story = {}
export const DatoolSandbox: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Local container")
    const dialog = await openProvider(canvasElement, "Datool Sandbox")
    await expect(
      dialog.queryByLabelText(/API token|Token secret/)
    ).not.toBeInTheDocument()
    await userEvent.click(dialog.getByRole("button", { name: "Add provider" }))
    await expectClosed()
    await userEvent.click(
      canvas.getByRole("button", { name: "Make Datool Sandbox default" })
    )
    await waitFor(() =>
      expect(
        canvas.getByRole("row", { name: /Datool Sandbox/ })
      ).toHaveTextContent("Default")
    )
    await expect(
      canvas.getByRole("row", { name: /Local container/ })
    ).toHaveTextContent("Available")
  },
}
export const Configured: Story = {
  beforeEach: () => {
    settings = {
      providers: sandboxProviderIds.map((id) => ({
        id,
        configured: true,
        ...(id === "vercel"
          ? { teamId: "team_demo", projectId: "prj_demo" }
          : {}),
      })),
      defaultProvider: "vercel",
      executionOrder: ["vercel", "local", "modal"],
    }
  },
}
export const ProviderPicker: Story = {
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText("Local container")
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Add provider" })
    )
    await expect(within(document.body).getByRole("dialog")).toHaveTextContent(
      "Add sandbox provider"
    )
  },
}
export const Empty: Story = {
  beforeEach: () => {
    settings = {
      providers: sandboxProviderIds.map((id) => ({ id, configured: false })),
      defaultProvider: null,
      executionOrder: [],
    }
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(/No sandbox providers configured/)
    const local = await openProvider(canvasElement, "Local container")
    await userEvent.click(local.getByRole("button", { name: "Add provider" }))
    await expectClosed()
    await expect(
      canvas.getByRole("row", { name: /Local container/ })
    ).toHaveTextContent("Default")
  },
}
export const MemberReadOnly: Story = {
  args: { canManage: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Local container")
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
          return HttpResponse.json(initial())
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
            { error: { message: "Unable to load sandbox providers." } },
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
        http.get(path, () => HttpResponse.json(initial())),
        http.put(path, () =>
          HttpResponse.json(
            {
              error: { message: "Unable to update sandbox provider settings." },
            },
            { status: 500 }
          )
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText("Local container")
    const modal = await openProvider(canvasElement, "Modal")
    await userEvent.type(modal.getByLabelText("Token ID"), "modal-id")
    await userEvent.type(modal.getByLabelText("Token secret"), "modal-secret")
    await userEvent.click(modal.getByRole("button", { name: "Add provider" }))
    await expect(modal.findByRole("alert")).resolves.toHaveTextContent(
      "Unable to update"
    )
    await expect(modal.getByLabelText("Token secret")).toHaveValue(
      "modal-secret"
    )
  },
}
