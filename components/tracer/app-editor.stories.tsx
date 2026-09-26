import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { getRouter } from "@storybook/nextjs-vite/navigation.mock"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { delay, http } from "msw"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import {
  data,
  failure,
} from "../../.storybook/scenarios/datasets-evals/handlers"
import type { AvailableApp } from "@/src/lib/playground/contracts"
import { AppDetailPage, AppEditor } from "./app-editor"

const app: AvailableApp = {
  id: "webhook-demo",
  name: "Webhook demo",
  mode: "input",
  revision: 1,
  inputSchema: { type: "object" },
  outputSchema: {},
  evaluatorIds: [],
  internalTracing: false,
  online: true,
  connection: {
    type: "webhook",
    url: "https://example.com/run",
    method: "POST",
    body: "input",
    timeoutMs: 60000,
    headerNames: ["Authorization"],
  },
}
const meta = {
  title: "Tracer/Playground/AppEditor",
  component: AppEditor,
  parameters: {
    layout: "fullscreen",
    nextjs: { navigation: { pathname: "/p/demo/apps/new" } },
  },
  decorators: [
    (Story) => (
      <StorybookProjectFrame
        title="New app"
        breadcrumbs={[{ label: "Playground", href: "/p/demo/playground" }]}
      >
        <Story />
      </StorybookProjectFrame>
    ),
  ],
} satisfies Meta<typeof AppEditor>
export default meta
type Story = StoryObj<typeof meta>

async function fillNewApp(canvasElement: HTMLElement) {
  const canvas = within(canvasElement)
  await userEvent.type(
    canvas.getByRole("textbox", { name: "Name" }),
    "Webhook demo"
  )
  await userEvent.type(
    canvas.getByRole("textbox", { name: "App ID" }),
    "webhook-demo"
  )
  await userEvent.type(
    canvas.getByRole("textbox", { name: "URL" }),
    "https://example.com/run"
  )
}

export const NewHttpApp: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post("/api/apps/config", async ({ request }) => {
          const [input] = (await request.json()) as AvailableApp[]
          await expect(input).toMatchObject({
            id: app.id,
            name: app.name,
            connection: { type: "webhook", url: "https://example.com/run" },
          })
          return data([app])
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    getRouter().replace.mockClear()
    const save = canvas.getByRole("button", { name: "Save" })
    await expect(save).toBeDisabled()
    await expect(
      canvas.getByRole("link", { name: "Playground" })
    ).toHaveAttribute("href", "/p/demo/playground")
    await fillNewApp(canvasElement)
    await userEvent.click(save)
    await waitFor(() =>
      expect(getRouter().replace).toHaveBeenCalledWith(
        "/p/demo/apps/webhook-demo"
      )
    )
    await expect(save).toBeDisabled()
    await expect(
      canvas.getByRole("link", { name: "Open playground" })
    ).toHaveAttribute("href", "/p/demo/playground/webhook-demo")
  },
}

export const EditAndRevert: Story = {
  args: { app },
  parameters: {
    nextjs: { navigation: { pathname: "/p/demo/apps/webhook-demo" } },
    msw: {
      handlers: [
        http.post("/api/apps/config", async ({ request }) => {
          const [input] = (await request.json()) as {
            expectedRevision: number
            connection: { headers?: unknown }
          }[]
          await expect(input.expectedRevision).toBe(1)
          await expect(input.connection.headers).toBeUndefined()
          return data([{ ...app, name: "Updated app", revision: 2 }])
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const save = canvas.getByRole("button", { name: "Save" })
    const name = canvas.getByRole("textbox", { name: "Name" })
    await expect(save).toBeDisabled()
    await expect(canvas.getByRole("textbox", { name: "App ID" })).toBeDisabled()
    await userEvent.type(name, " edited")
    await expect(save).toBeEnabled()
    await userEvent.clear(name)
    await userEvent.type(name, app.name)
    await expect(save).toBeDisabled()
    await userEvent.clear(name)
    await userEvent.type(name, "Updated app")
    await userEvent.click(save)
    await waitFor(() => expect(save).toBeDisabled())
    await expect(
      canvas.getByRole("textbox", { name: "Headers (JSON)" })
    ).toHaveValue("")
  },
}

export const LocalBridge: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.selectOptions(
      canvas.getByRole("combobox", { name: "Connection type" }),
      "bridge"
    )
    await expect(canvas.getByText("bunx datool connect")).toBeVisible()
    await expect(
      canvas.queryByRole("textbox", { name: "URL" })
    ).not.toBeInTheDocument()
    await userEvent.selectOptions(
      canvas.getByRole("combobox", { name: "Connection type" }),
      "webhook"
    )
    await expect(canvas.getByRole("textbox", { name: "URL" })).toBeVisible()
  },
}

export const SaveFailure: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post("/api/apps/config", () =>
          failure("App changed. Reload its configuration before saving.")
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await fillNewApp(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: "Save" })
    )
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "App changed"
    )
    await expect(canvas.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Webhook demo"
    )
  },
}

export const Loading: Story = {
  render: () => <AppDetailPage appId={app.id} />,
  parameters: {
    msw: {
      handlers: [
        http.get("/api/apps/config", async () => {
          await delay("infinite")
          return data([])
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("Loading app")
    ).resolves.toBeInTheDocument()
  },
}

export const LoadFailure: Story = {
  render: () => <AppDetailPage appId={app.id} />,
  parameters: {
    msw: {
      handlers: [
        http.get("/api/apps/config", () => failure("Unable to load app")),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("alert")
    ).resolves.toHaveTextContent("Unable to load app")
  },
}

export const SavedApp: Story = {
  render: () => <AppDetailPage appId={app.id} />,
  parameters: {
    msw: { handlers: [http.get("/api/apps/config", () => data([app]))] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("textbox", { name: "Name" })
    ).resolves.toHaveValue(app.name)
    await expect(
      canvas.getByRole("button", { name: "Save" })
    ).toBeDisabled()
  },
}
