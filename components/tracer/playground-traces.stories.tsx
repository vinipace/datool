import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, waitFor, within } from "storybook/test"
import { http } from "msw"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import {
  data,
  datasetsEvalsHandlers,
  failure,
} from "../../.storybook/scenarios/datasets-evals/handlers"
import {
  evalRun,
  evaluators,
  playgroundAttempt,
} from "../../.storybook/scenarios/datasets-evals/fixtures"
import { PlaygroundTraces } from "./playground-traces"

const meta = {
  title: "Tracer/Playground/PlaygroundTraces",
  component: PlaygroundTraces,
  parameters: {
    layout: "fullscreen",
    nextjs: { navigation: { pathname: "/p/demo/playground" } },
  },
  render: (args) => (
    <StorybookProjectFrame title="Invoice assistant traces">
      <div className="flex min-h-0 flex-1">
        <PlaygroundTraces {...args} />
      </div>
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof PlaygroundTraces>

export default meta
type Story = StoryObj<typeof meta>

export const ReceivedTraces: Story = {
  // TODO(a11y): Overflow trace-tag metadata is 3.99:1 on the dark canvas.
  // Source: components/tracer/trace-list-table.tsx.
  args: {
    attempts: [playgroundAttempt],
    connectionId: "app-storybook-support",
    evaluatorIds: evaluators.map((item) => item.id),
    evaluators,
  },
  parameters: {
    a11y: { test: "todo" },
    docs: {
      description: {
        story:
          "Known product accessibility debt: overflow trace-tag metadata is 3.99:1 on the dark canvas in components/tracer/trace-list-table.tsx.",
      },
    },
    msw: { handlers: datasetsEvalsHandlers },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByRole("row", { name: /Open Resolve invoice question/ })
      ).toBeVisible()
    )
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

export const TraceFailure: Story = {
  // TODO(a11y): The product error notice is 4.4:1 on the dark canvas.
  // Source: components/tracer/playground-traces.tsx.
  args: {
    attempts: [playgroundAttempt],
    connectionId: "app-storybook-support",
    evaluatorIds: evaluators.map((item) => item.id),
    evaluators,
  },
  parameters: {
    a11y: { test: "todo" },
    docs: {
      description: {
        story:
          "Known product accessibility debt: the playground trace-stream error notice is 4.4:1 on the dark canvas in components/tracer/playground-traces.tsx.",
      },
    },
    msw: {
      handlers: [
        http.get("/api/custom-fields", () => data([])),
        http.get("/api/custom-views", () => data([])),
        http.get("/api/evals/:runId", () => data(evalRun)),
        http.get("/api/traces", () => failure("Trace stream is unavailable")),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("Trace stream is unavailable")
    ).resolves.toBeVisible()
  },
}
