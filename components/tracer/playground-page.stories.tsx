import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import { delay, http } from "msw"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import {
  data,
  failure,
} from "../../.storybook/scenarios/datasets-evals/handlers"
import { availableApps } from "../../.storybook/scenarios/datasets-evals/fixtures"
import { PlaygroundPage } from "./playground-page"

const meta = {
  title: "Tracer/Playground/PlaygroundPage",
  component: PlaygroundPage,
  parameters: {
    layout: "fullscreen",
    nextjs: { navigation: { pathname: "/p/demo/playground" } },
  },
  render: () => (
    <StorybookProjectFrame title="Playground">
      <PlaygroundPage />
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof PlaygroundPage>
export default meta
type Story = StoryObj<typeof meta>

export const RegisteredApps: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/apps/config", () =>
          data([
            ...availableApps,
            {
              ...availableApps[0],
              id: "offline-agent",
              name: "Offline agent",
              mode: "agent",
              online: false,
            },
          ])
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("link", { name: /Invoice assistant/ })
    ).resolves.toHaveAttribute(
      "href",
      "/p/demo/playground/app-storybook-support"
    )
    await expect(canvas.getByText("Offline")).toBeVisible()
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Search apps" }),
      "missing"
    )
    await expect(canvas.findByText("No matching apps.")).resolves.toBeVisible()
    await userEvent.clear(canvas.getByRole("textbox", { name: "Search apps" }))
    await expect(
      canvas.findByRole("link", { name: /Invoice assistant/ })
    ).resolves.toBeVisible()
  },
}
export const Empty: Story = {
  parameters: {
    msw: { handlers: [http.get("/api/apps/config", () => data([]))] },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("bunx datool connect")
    ).resolves.toBeVisible()
  },
}
export const Loading: Story = {
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
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("Loading registered apps")
    ).resolves.toBeInTheDocument()
    await expect(
      canvas.queryByText("No registered apps yet.")
    ).not.toBeInTheDocument()
  },
}
export const LoadFailure: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/apps/config", () => failure("Could not load apps")),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("alert")
    ).resolves.toHaveTextContent("Could not load apps")
  },
}

export const NewAppLink: Story = {
  ...Empty,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByRole("link", { name: "New app" })).resolves.toHaveAttribute("href", "/p/demo/apps/new")
    await expect(canvas.queryByRole("dialog")).not.toBeInTheDocument()
  },
}
