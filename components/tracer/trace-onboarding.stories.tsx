import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, spyOn, userEvent, waitFor, within } from "storybook/test"
import { workspaceScopes } from "@/src/lib/auth/permissions"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import {
  envelope,
  list,
  traceRows,
} from "../../.storybook/scenarios/traces/fixtures"
import { onboardingHandlers } from "../../.storybook/scenarios/traces/handlers"
import { delay, http, HttpResponse } from "msw"
import { TraceOnboarding } from "./trace-onboarding"

function OnboardingExample() {
  return (
    <StorybookProjectFrame title="Traces">
      <TraceOnboarding
        fallback={<p className="p-4 text-sm">Existing trace rows</p>}
      />
    </StorybookProjectFrame>
  )
}

const meta = {
  title: "Tracer/TraceOnboarding",
  component: TraceOnboarding,
  parameters: {
    layout: "fullscreen",
    msw: {
      handlers: [
        http.get("/api/traces", () => HttpResponse.json(envelope(list([])))),
        ...onboardingHandlers,
      ],
    },
  },
  render: () => <OnboardingExample />,
} satisfies Meta<typeof TraceOnboarding>

export default meta
type Story = StoryObj<typeof OnboardingExample>

const createKeyRequest = fn()

export const FirstTraceSetup: Story = {
  beforeEach: () => {
    createKeyRequest.mockClear()
  },
  parameters: {
    msw: {
      handlers: [
        http.post(
          "/api/organizations/:organizationId/api-keys",
          async ({ request }) => {
            createKeyRequest(await request.json())
            return HttpResponse.json(
              envelope({ key: "dtl_storybook_fixture_key" })
            )
          }
        ),
        http.get("/api/traces", () => HttpResponse.json(envelope(list([])))),
        ...onboardingHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("heading", { name: "Send your first trace" })
    ).resolves.toBeVisible()
    await userEvent.click(canvas.getByRole("tab", { name: "Manual" }))
    const input = await canvas.findByRole(
      "textbox",
      { name: "Datool environment variables" },
      { timeout: 10_000 }
    )
    const { monaco } = await import("./monaco-runtime")
    const editor = monaco.editor
      .getEditors()
      .find((candidate) => candidate.getDomNode()?.contains(input))!
    await expect(editor.getValue()).toContain("DATOOL_API_KEY=<your-api-key>")
    await expect(
      canvas.getByRole("button", { name: "Copy .env" })
    ).toBeDisabled()
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Generate API key",
      })
    )
    await expect(
      canvas.findByRole("button", { name: "API key created" })
    ).resolves.toBeDisabled()
    await expect(createKeyRequest).toHaveBeenCalledTimes(1)
    await expect(createKeyRequest).toHaveBeenCalledWith({
      name: expect.stringMatching(/^Application /),
      scopes: [...workspaceScopes],
      expiresIn: null,
    })
    await waitFor(() =>
      expect(editor.getValue()).toContain(
        "DATOOL_API_KEY=dtl_storybook_fixture_key"
      )
    )
    await expect(
      canvas.getByRole("button", { name: "Copy .env" })
    ).toBeEnabled()
    const generatedEnv = editor.getValue()
    await userEvent.click(input)
    await expect(input).toHaveFocus()
    await userEvent.paste("accidental edit")
    await expect(editor.getValue()).toBe(generatedEnv)
    const writeClipboard = spyOn(
      navigator.clipboard,
      "writeText"
    ).mockResolvedValue()
    try {
      await userEvent.click(canvas.getByRole("button", { name: "Copy .env" }))
      await expect(writeClipboard).toHaveBeenCalledWith(generatedEnv)
      await expect(canvas.getByRole("status")).toHaveTextContent(
        "Environment variables copied"
      )
    } finally {
      writeClipboard.mockRestore()
    }
  },
}

export const CheckingProject: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/traces", async () => {
          await delay("infinite")
          return HttpResponse.json(envelope(list([])))
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("Checking project traces…")
    ).resolves.toBeInTheDocument()
    await expect(
      canvas.queryByRole("heading", { name: "Send your first trace" })
    ).not.toBeInTheDocument()
    await expect(
      canvas.queryByText("Existing trace rows")
    ).not.toBeInTheDocument()
  },
}

export const ExistingProject: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/traces", async () => {
          await delay(800)
          return HttpResponse.json(envelope(list(traceRows.slice(0, 1))))
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText("Checking project traces…")
    ).resolves.toBeInTheDocument()
    await expect(
      canvas.queryByRole("heading", { name: "Send your first trace" })
    ).not.toBeInTheDocument()
    await expect(
      canvas.findByText("Existing trace rows")
    ).resolves.toBeVisible()
    await expect(
      canvas.queryByRole("heading", { name: "Send your first trace" })
    ).not.toBeInTheDocument()
  },
}

export const FailedCheck: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get(
          "/api/traces",
          () =>
            HttpResponse.json(
              { error: { message: "Unable to check project traces" } },
              { status: 503 }
            ),
          { once: true }
        ),
        http.get("/api/traces", () =>
          HttpResponse.json(envelope(list(traceRows.slice(0, 1))))
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Unable to check project traces"
    )
    await expect(
      canvas.queryByRole("heading", { name: "Send your first trace" })
    ).not.toBeInTheDocument()
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }))
    await expect(
      canvas.findByText("Existing trace rows")
    ).resolves.toBeVisible()
  },
}

export const Overview: Story = {}

export const AutoPrompt: Story = {
  parameters: FirstTraceSetup.parameters,
  beforeEach: FirstTraceSetup.beforeEach,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("tab", { name: "Auto" })
    ).resolves.toHaveAttribute("aria-selected", "true")
    const copyPrompt = canvas.getByRole("button", { name: "Copy setup prompt" })
    await expect(copyPrompt).toBeDisabled()
    await userEvent.click(
      await canvas.findByRole("button", { name: "Generate API key" })
    )
    await waitFor(() => expect(copyPrompt).toBeEnabled())
    const writeClipboard = spyOn(
      navigator.clipboard,
      "writeText"
    ).mockResolvedValue()
    try {
      await userEvent.click(copyPrompt)
      const prompt = writeClipboard.mock.calls[0][0]
      await expect(prompt).toContain("DATOOL_API_KEY=dtl_storybook_fixture_key")
      await expect(prompt).toContain("@datool/sdk/otel")
      await expect(prompt).toContain("/docs/tracing/instrumentation")
      await expect(canvas.getByRole("status")).toHaveTextContent(
        "Setup prompt copied"
      )
      await userEvent.click(canvas.getByRole("tab", { name: "Manual" }))
      const input = await canvas.findByRole(
        "textbox",
        { name: "Datool environment variables" },
        { timeout: 10_000 }
      )
      const { monaco } = await import("./monaco-runtime")
      const editor = monaco.editor
        .getEditors()
        .find((candidate) => candidate.getDomNode()?.contains(input))!
      await expect(prompt).toContain(editor.getValue())
      await expect(editor.getValue()).toContain(
        "DATOOL_API_KEY=dtl_storybook_fixture_key"
      )
      await expect(
        canvas.getByRole("button", { name: "API key created" })
      ).toBeDisabled()
      await userEvent.click(canvas.getByRole("tab", { name: "Auto" }))
      await userEvent.click(
        canvas.getByRole("button", { name: "Copy setup prompt" })
      )
      await expect(writeClipboard).toHaveBeenLastCalledWith(prompt)
      await expect(createKeyRequest).toHaveBeenCalledTimes(1)
    } finally {
      writeClipboard.mockRestore()
    }
  },
}

export const PromptCopyFailure: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Generate API key" })
    )
    const copyPrompt = canvas.getByRole("button", { name: "Copy setup prompt" })
    await waitFor(() => expect(copyPrompt).toBeEnabled())
    const writeClipboard = spyOn(
      navigator.clipboard,
      "writeText"
    ).mockRejectedValue(new Error("Clipboard denied"))
    try {
      await userEvent.click(copyPrompt)
      await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
        "Clipboard access failed"
      )
      await userEvent.click(canvas.getByText("View prompt"))
      await expect(
        canvas.getByRole("textbox", { name: "Agent setup prompt" })
      ).toBeVisible()
      await expect(
        (
          canvas.getByRole("textbox", {
            name: "Agent setup prompt",
          }) as HTMLTextAreaElement
        ).value
      ).toContain("DATOOL_API_KEY=dtl_storybook_fixture_key")
      await expect(
        canvas.getByRole("button", { name: "API key created" })
      ).toBeDisabled()
    } finally {
      writeClipboard.mockRestore()
    }
  },
}
