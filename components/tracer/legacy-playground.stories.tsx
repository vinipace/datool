import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { http } from "msw"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import {
  datasetsEvalsHandlers,
  failure,
} from "../../.storybook/scenarios/datasets-evals/handlers"
import { LegacyPlayground } from "./legacy-playground"

const meta = {
  title: "Tracer/Playground/LegacyPlayground",
  component: LegacyPlayground,
  parameters: {
    layout: "fullscreen",
    nextjs: { navigation: { pathname: "/p/demo/playground" } },
  },
  render: () => (
    <StorybookProjectFrame title="Legacy playground">
      <LegacyPlayground />
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof LegacyPlayground>

export default meta
type Story = StoryObj<typeof meta>

export const InputAppExecution: Story = {
  // TODO(a11y): Overflow trace-tag metadata is 3.73:1 on the dark canvas.
  // Source: components/tracer/trace-list-table.tsx.
  parameters: {
    a11y: { test: "todo" },
    docs: {
      description: {
        story:
          "Known product accessibility debt: overflow trace-tag metadata is 3.73:1 on the dark canvas in components/tracer/trace-list-table.tsx.",
      },
    },
    msw: { handlers: datasetsEvalsHandlers },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("option", { name: /Invoice assistant/ })
    ).resolves.toBeVisible()
    await userEvent.selectOptions(
      await canvas.findByLabelText("App"),
      "app-storybook-support"
    )
    await userEvent.click(canvas.getByLabelText("JSON input"))
    await userEvent.paste(
      JSON.stringify({ question: "Where is my latest invoice?" })
    )
    await userEvent.click(canvas.getByRole("button", { name: "Run" }))
    await expect(
      canvas.findByText(
        (_, element) =>
          element?.tagName === "PRE" &&
          element.textContent?.includes(
            "September invoice is ready in the billing portal"
          ) === true
      )
    ).resolves.toBeVisible()
    await waitFor(() => {
      const row = canvas.getByRole("row", {
        name: /Open Resolve invoice question/,
      })
      expect(getComputedStyle(row).opacity).toBe("1")
      expect(
        row
          .getAnimations()
          .some((animation) => animation.playState === "running")
      ).toBe(false)
    })
  },
}

export const AppListFailure: Story = {
  // TODO(a11y): The product error notice is 4.4:1 on the dark canvas.
  // Source: components/tracer/legacy-playground.tsx.
  parameters: {
    a11y: { test: "todo" },
    docs: {
      description: {
        story:
          "Known product accessibility debt: the legacy-playground app-list error notice is 4.4:1 on the dark canvas in components/tracer/legacy-playground.tsx.",
      },
    },
    msw: {
      handlers: [
        http.get("/api/apps", () => failure("Connected apps are unavailable")),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("alert")
    ).resolves.toHaveTextContent("Connected apps are unavailable")
  },
}
