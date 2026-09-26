import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { productPillars } from "@/lib/marketing/product"
import { FeatureVisual, ProductPreview } from "./product-visuals"

const meta = {
  title: "CMS/Product explanations",
  component: ProductPreview,
  args: { pillar: productPillars[0] },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-6xl p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProductPreview>
export default meta
type Story = StoryObj<typeof meta>

export const Build: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("tab", { name: "Original prompt" }))
    await expect(
      canvas.getByRole("tabpanel", { name: "Original prompt" })
    ).toHaveTextContent("Yes! You can return your order within 60 days.")
    await userEvent.keyboard("{ArrowRight}")
    await expect(
      canvas.getByRole("tab", { name: "With context" })
    ).toHaveAttribute("aria-selected", "true")
    await waitFor(
      () =>
        expect(
          canvas.getByText("Grounded in the supplied policy")
        ).toBeVisible(),
      { timeout: 4_000 }
    )
    await settleMotion(canvasElement)
    await expect(
      canvas.queryByText("Confident answer. Wrong policy.")
    ).not.toBeInTheDocument()
  },
}
export const Observe: Story = {
  args: { pillar: productPillars[1] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: /search.documents/ })
    )
    await expect(
      canvas.getByLabelText("Selected span details")
    ).toHaveTextContent("Returns are accepted within 30 days of delivery.")
    await userEvent.click(
      canvas.getByRole("button", { name: /generate.answer/ })
    )
    await expect(
      canvas.getByLabelText("Selected span details")
    ).toHaveTextContent("Yes! You can return your order within 60 days.")
    await expect(
      canvas.getByText(
        "The answer contradicts the retrieved policy. This is the step to investigate."
      )
    ).toBeVisible()
  },
}
export const Evaluate: Story = {
  args: { pillar: productPillars[2] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const replay = canvas.getByRole("button", {
      name: "Replay evaluation comparison",
    })
    await waitFor(() => expect(replay).toBeDisabled())
    await waitFor(() => expect(replay).toBeEnabled(), { timeout: 5_000 })
    await userEvent.click(replay)
    await expect(replay).toBeDisabled()
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "Checking the same 24 cases"
    )
    await waitFor(
      () => {
        expect(
          canvas.getByRole("img", {
            name: "18 passed, 24 of 24 cases checked",
          })
        ).toBeVisible()
        expect(
          canvas.getByRole("img", {
            name: "23 passed, 24 of 24 cases checked",
          })
        ).toBeVisible()
        expect(replay).toBeEnabled()
      },
      { timeout: 5_000 }
    )
    await userEvent.click(canvas.getByRole("tab", { name: "Unknown answer" }))
    await expect(
      canvas.getByRole("tabpanel", { name: "Unknown answer" })
    ).toHaveTextContent("Still failing")
    await expect(
      canvas.getByText(
        "The source does not cover custom items. A citation alone does not make an answer correct."
      )
    ).toBeVisible()
    await userEvent.keyboard("{ArrowLeft}")
    await expect(
      canvas.getByRole("tabpanel", { name: "Missing source" })
    ).toHaveTextContent("Improved")
    await expect(canvas.queryByText("Still failing")).not.toBeInTheDocument()
  },
}

export const ReadOnlyScorer: Story = {
  render: () => <FeatureVisual feature="scorers" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("tabpanel", { name: "LLM" })
    ).toHaveTextContent("Datool Scorer Model")
    const initialRubric = await canvas.findByRole(
      "textbox",
      { name: "LLM scorer rubric example (read only)" },
      { timeout: 10_000 }
    )
    await waitFor(
      () => expect(canvas.queryAllByText("Loading editor…")).toHaveLength(0),
      { timeout: 10_000 }
    )
    const panels = canvas.getByRole("tabpanel", { name: "LLM" }).parentElement!
    // Let Monaco finish measuring the wrapped text before comparing the tabs.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )
    const initialHeight = panels.getBoundingClientRect().height
    await userEvent.click(canvas.getByRole("tab", { name: /javascript/i }))
    const input = await waitFor(
      () =>
        canvas.getByRole("textbox", {
          name: "citation-check.js example (read only)",
        }),
      { timeout: 10_000 }
    )
    const { monaco } = await import("@/components/tracer/monaco-runtime")
    const editor = monaco.editor
      .getEditors()
      .find((candidate) => candidate.getDomNode()?.contains(input))
    if (!editor) throw new Error("The scorer example did not load Monaco")
    await expect(panels.getBoundingClientRect().height).toBe(initialHeight)
    await expect(initialRubric.closest('[role="tabpanel"]')).toHaveAttribute(
      "inert"
    )
    const original = editor.getValue()
    await expect(editor.getOption(monaco.editor.EditorOption.readOnly)).toBe(
      true
    )
    await userEvent.click(input)
    await userEvent.paste("This must not replace the example")
    await expect(editor.getValue()).toBe(original)
    await userEvent.click(canvasElement)
    await expect(canvas.queryByText("Loading editor…")).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("tab", { name: "LLM" }))
    const rubricInput = await canvas.findByRole("textbox", {
      name: "LLM scorer rubric example (read only)",
    })
    await expect(rubricInput).toBe(initialRubric)
    await expect(panels.getBoundingClientRect().height).toBe(initialHeight)
    await expect(input.closest('[role="tabpanel"]')).toHaveAttribute("inert")
    await expect(canvas.queryAllByRole("tabpanel")).toHaveLength(1)
    const rubricEditor = monaco.editor
      .getEditors()
      .find((candidate) => candidate.getDomNode()?.contains(rubricInput))
    if (!rubricEditor) throw new Error("The LLM rubric did not load Monaco")
    await expect(rubricEditor.getValue()).toContain("{{expected}}")
    await expect(
      rubricEditor.getOption(monaco.editor.EditorOption.readOnly)
    ).toBe(true)
    await expect(
      canvas.getByRole("tabpanel", { name: "LLM" })
    ).toHaveTextContent("Choice scores")
  },
}
export const Discover: Story = {
  args: { pillar: productPillars[3] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("tab", { name: "Cost" }))
    await expect(
      canvas.getByRole("tabpanel", { name: "Cost" })
    ).toHaveTextContent("$0.06")
    await waitFor(
      () =>
        expect(
          canvas.getByText("Longer prompts are driving the increase.")
        ).toBeVisible(),
      { timeout: 4_000 }
    )
    await userEvent.keyboard("{ArrowRight}")
    await expect(
      canvas.getByRole("tabpanel", { name: "Quality" })
    ).toHaveTextContent("86%")
    await expect(
      canvas.getByRole("img", { name: "Quality trend over seven days" })
    ).toBeVisible()
    await settleMotion(canvasElement)
  },
}

async function settleMotion(element: HTMLElement) {
  await waitFor(() =>
    expect(element.querySelector('[data-animate="true"]')).toBeInTheDocument()
  )
  await waitFor(
    () =>
      expect(
        element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.playState === "running")
      ).toHaveLength(0),
    { timeout: 6_000 }
  )
}

export const PromptVersions: Story = {
  render: () => <FeatureVisual feature="prompts" />,
  play: async ({ canvasElement }) => {
    await settleMotion(canvasElement)
  },
}
export const Playground: Story = {
  render: () => <FeatureVisual feature="playground" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByText("npx datool connect ./handler.ts --watch")
    ).toBeVisible()
  },
}
export const DashboardBreakdown: Story = {
  render: () => <FeatureVisual feature="dashboards" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByLabelText("Span latency chart")
    ).resolves.toBeVisible()
    const latency = within(canvas.getByLabelText("Span latency chart"))
    latency.getByRole("application").focus()
    await userEvent.keyboard("{ArrowLeft}")
    await waitFor(() => expect(latency.getByText("2026-09-01")).toBeVisible())
    await expect(latency.getByText("1.24s")).toBeVisible()
    await expect(latency.getByText("0.82s")).toBeVisible()
    await expect(latency.getByText("0.26s")).toBeVisible()
    const volume = within(canvas.getByLabelText("Spans by operation chart"))
    volume.getByRole("application").focus()
    await userEvent.keyboard("{ArrowLeft}")
    await waitFor(() => expect(volume.getByText("2026-09-01")).toBeVisible())
    for (const operation of [
      "search.documents",
      "generate.answer",
      "verify.sources",
    ]) {
      await expect(volume.getByText(operation)).toBeVisible()
    }
  },
}
export const SlackAlert: Story = {
  render: () => <FeatureVisual feature="alerts" />,
  play: async ({ canvasElement }) => {
    await settleMotion(canvasElement)
    await expect(
      within(canvasElement).getByText(
        "10 failed requests in the last 5 minutes."
      )
    ).toBeVisible()
  },
}
export const TraceFeature: Story = {
  render: () => <FeatureVisual feature="traces" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByLabelText("Trace timeline")).toBeVisible()
    const span = await canvas.findByRole("button", { name: /support.agent/ })
    const rect = span.getBoundingClientRect()
    await userEvent.pointer({
      target: span,
      keys: "[MouseLeft]",
      coords: {
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      },
    })
    await expect(
      canvas.getByLabelText("Selected span details")
    ).toHaveTextContent("Yes! You can return your order within 60 days.")
  },
}
