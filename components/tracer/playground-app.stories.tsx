import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  getRouter,
  ReadonlyURLSearchParams,
  useSearchParams,
} from "@storybook/nextjs-vite/navigation.mock"
import { delay, http } from "msw"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import {
  data,
  failure,
} from "../../.storybook/scenarios/datasets-evals/handlers"
import {
  supportApp,
  traceDetail,
} from "../../.storybook/scenarios/datasets-evals/fixtures"
import { PlaygroundAppPage } from "./playground-page"

const invocation = {
  ...traceDetail,
  id: "invocation",
  name: "Invocation",
  input: supportApp.defaultInput,
  spans: [],
  attributes: {
    "datool.call.id": "call",
    "datool.connection.id": supportApp.id,
  },
}
const captured = {
  ...traceDetail,
  id: "captured",
  name: "Captured workflow",
  spans: traceDetail.spans.map((span) => ({ ...span, traceId: "captured" })),
}
const meta = {
  title: "Tracer/Playground/App",
  component: PlaygroundAppPage,
  args: { appId: supportApp.id },
  beforeEach: () => { localStorage.removeItem("datool:playground:inspector-tab"); return () => localStorage.removeItem("datool:playground:inspector-tab") },
  parameters: {
    layout: "fullscreen",
    nextjs: {
      navigation: {
        pathname: `/p/demo/playground/${supportApp.id}`,
        query: {},
      },
    },
    msw: { handlers: [
        http.get("/api/evaluators", () => data({ items: [], nextCursor: null })),
        http.get("/api/traces/:id/scores", () => data({ items: [], nextCursor: null })),http.get("/api/apps/config", () => data([supportApp]))] },
  },
  render: (args) => (
    <StorybookProjectFrame title="Playground app">
      <PlaygroundAppPage {...args} />
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof PlaygroundAppPage>
export default meta
type Story = StoryObj<typeof meta>

export const Input: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("textbox", { name: "question" })
    ).resolves.toHaveValue("Where is my latest invoice?")
    await expect(canvas.getByRole("button", { name: "Run" })).toBeEnabled()
    await expect(
      canvas.getByText("Run this app to see its captured traces.")
    ).toBeVisible()
    await expect(
      canvas.queryByRole("option", { name: "Chat" })
    ).not.toBeInTheDocument()
  },
}

async function codeInput(canvasElement: HTMLElement, label: string) {
  const textbox = await within(canvasElement).findByRole(
    "textbox",
    { name: label },
    { timeout: 10_000 }
  )
  const { monaco } = await import("@/components/tracer/monaco-runtime")
  const editor = monaco.editor
    .getEditors()
    .find((editor) => editor.getDomNode()?.contains(textbox))
  if (!editor) throw new Error("Input editor did not mount")
  return { textbox, editor }
}

async function editCodeInput(
  canvasElement: HTMLElement,
  label: string,
  value: string
) {
  const { textbox, editor } = await codeInput(canvasElement, label)
  await userEvent.click(textbox)
  editor.trigger("storybook", "editor.action.selectAll", undefined)
  await userEvent.paste(value)
  await waitFor(() => expect(editor.getValue()).toBe(value))
}

let submittedInput: unknown
export const InputFormats: Story = {
  beforeEach: () => {
    submittedInput = undefined
  },
  parameters: {
    msw: {
      handlers: [
        http.get("/api/evaluators", () => data({ items: [], nextCursor: null })),
        http.get("/api/traces/:id/scores", () => data({ items: [], nextCursor: null })),
        http.get("/api/apps/config", () => data([supportApp])),
        http.post("/api/apps/:id/runs", async ({ request }) => {
          submittedInput = await request.json()
          return data({ traceId: "format-run" })
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.clear(
      await canvas.findByRole("textbox", { name: "question" })
    )
    await userEvent.type(
      canvas.getByRole("textbox", { name: "question" }),
      "Edited in the form"
    )
    const format = canvas.getByRole("combobox", { name: "Input format" })
    await userEvent.selectOptions(format, "json")
    await expect(
      (await codeInput(canvasElement, "JSON input")).editor.getValue()
    ).toContain("Edited in the form")
    await userEvent.selectOptions(format, "yaml")
    await expect(
      (await codeInput(canvasElement, "YAML input")).editor.getValue()
    ).toContain("question: Edited in the form")
    await editCodeInput(
      canvasElement,
      "YAML input",
      "question: Edited in YAML\ncount: 0\nenabled: false\n"
    )
    await userEvent.selectOptions(format, "form")
    await expect(canvas.getByRole("textbox", { name: "question" })).toHaveValue(
      "Edited in YAML"
    )
    await userEvent.selectOptions(format, "json")
    const expected = { question: "Edited in YAML", count: 0, enabled: false }
    await expect(
      JSON.parse(
        (await codeInput(canvasElement, "JSON input")).editor.getValue()
      )
    ).toEqual(expected)
    await userEvent.click(canvas.getByRole("button", { name: "Run" }))
    await waitFor(() => expect(submittedInput).toEqual(expected))
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Run" })).toBeEnabled()
    )
    await userEvent.selectOptions(format, "form")
  },
}

export const InvalidInputDraft: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const format = await canvas.findByRole("combobox", { name: "Input format" })
    await userEvent.selectOptions(format, "json")
    await editCodeInput(canvasElement, "JSON input", '{"question":')
    await expect(canvas.getByRole("alert")).toBeVisible()
    await expect(canvas.getByRole("button", { name: "Run" })).toBeDisabled()
    await userEvent.selectOptions(format, "form")
    await expect(format).toHaveValue("json")
    await expect(
      (await codeInput(canvasElement, "JSON input")).editor.getValue()
    ).toBe('{"question":')
    await editCodeInput(
      canvasElement,
      "JSON input",
      '{"question":"Fixed input"}'
    )
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
    await expect(canvas.getByRole("button", { name: "Run" })).toBeEnabled()
    await userEvent.selectOptions(format, "form")
    await expect(canvas.getByRole("textbox", { name: "question" })).toHaveValue(
      "Fixed input"
    )
  },
}

export const Offline: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/evaluators", () => data({ items: [], nextCursor: null })),
        http.get("/api/traces/:id/scores", () => data({ items: [], nextCursor: null })),
        http.get("/api/apps/config", () =>
          data([{ ...supportApp, online: false }])
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("button", { name: "Run" })
    ).resolves.toBeDisabled()
  },
}
export const RunFailure: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/evaluators", () => data({ items: [], nextCursor: null })),
        http.get("/api/traces/:id/scores", () => data({ items: [], nextCursor: null })),
        http.get("/api/apps/config", () => data([supportApp])),
        http.post("/api/apps/:id/runs", () => failure("Listener disconnected")),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole("button", { name: "Run" }))
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Listener disconnected"
    )
    await expect(canvas.getByRole("textbox", { name: "question" })).toHaveValue(
      "Where is my latest invoice?"
    )
  },
}
export const MultipleTraces: Story = {
  parameters: {
    nextjs: { navigation: { query: { run: "invocation" } } },
    msw: {
      handlers: [
        http.get("/api/evaluators", () => data({ items: [], nextCursor: null })),
        http.get("/api/traces/:id/scores", () => data({ items: [], nextCursor: null })),
        http.get("/api/apps/config", () => data([supportApp])),
        http.get("/api/traces/invocation/payload", () => data(invocation)),
        http.get("/api/traces", () =>
          data({ items: [invocation, captured], nextCursor: null })
        ),
        http.get("/api/traces/:id/overview", async ({ params }) => {
          // Trace counts load before the hierarchy's independent overview reads.
          await delay(250)
          return data(params.id === invocation.id ? invocation : captured)
        }),
        http.get("/api/traces/captured/payload", () => data(captured)),
        http.get("/api/traces/:id/spans", ({ params }) => data({ items: params.id === invocation.id ? [] : captured.spans, nextCursor: null })),
        http.get("/api/traces/:id/spans/:spanId/detail", ({ params }) =>
          data(captured.spans.find((span) => span.id === params.spanId))
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText(/2 traces ·/)).resolves.toBeVisible()
    const hierarchy = within(
      await canvas.findByRole("region", { name: "Run trace hierarchy" })
    )
    await expect(
      hierarchy.findByRole("button", { name: /Invocation/ })
    ).resolves.toBeVisible()
    const child = await hierarchy.findByRole("button", {
      name: new RegExp(`^workflow ${captured.spans[0].name}`),
    })
    await userEvent.click(child)
    await expect(child).toHaveAttribute("aria-pressed", "true")
    await userEvent.click(canvas.getByRole("button", { name: "Timeline" }))
    await expect(canvas.getByRole("region", { name: "Run timeline" })).toBeVisible()
    await waitFor(() => expect(canvas.getByRole("region", { name: "Run timeline" }).querySelectorAll("[data-span-id]").length).toBeGreaterThan(1))
    await userEvent.click(canvas.getByRole("button", { name: "Views" }))
    await expect(canvas.findByRole("combobox", { name: "React view" })).resolves.toBeVisible()
    await expect(canvas.getByRole("combobox", { name: "Trace for custom view" })).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Trace" }))
  },
}

const replacement = {
  ...invocation,
  id: "replacement",
  name: "Replacement result",
  attributes: {
    ...invocation.attributes,
    "datool.call.id": "replacement-call",
  },
}
let finishRun: ((response: Response) => void) | undefined
let finishTrace: (() => void) | undefined

export const RetainResultWhileRunning: Story = {
  beforeEach: () => {
    finishRun = undefined
    finishTrace = undefined
    const previousParams = useSearchParams.getMockImplementation()
    const router = getRouter()
    useSearchParams.mockReturnValue(
      new ReadonlyURLSearchParams("run=invocation")
    )
    router.replace.mockImplementation((href: string) => {
      useSearchParams.mockReturnValue(
        new ReadonlyURLSearchParams(
          new URL(href, "http://localhost").searchParams
        )
      )
    })
    return () => {
      if (previousParams) useSearchParams.mockImplementation(previousParams)
      router.replace.mockReset()
    }
  },
  parameters: {
    msw: {
      handlers: [
        http.get("/api/evaluators", () => data({ items: [], nextCursor: null })),
        http.get("/api/traces/:id/scores", () => data({ items: [], nextCursor: null })),
        http.get("/api/apps/config", () => data([supportApp])),
        http.post(
          "/api/apps/:id/runs",
          () =>
            new Promise<Response>((resolve) => {
              finishRun = resolve
            })
        ),
        http.get("/api/traces/invocation/payload", () => data(invocation)),
        http.get(
          "/api/traces/replacement/payload",
          () =>
            new Promise<Response>((resolve) => {
              finishTrace = () => resolve(data(replacement))
            })
        ),
        http.get("/api/traces", ({ request }) =>
          data({
            items: new URL(request.url).searchParams
              .get("filter")
              ?.includes("replacement-call")
              ? [replacement]
              : [invocation],
            nextCursor: null,
          })
        ),
        http.get("/api/traces/:id/overview", ({ params }) =>
          data(params.id === "replacement" ? replacement : invocation)
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("heading", { name: "Invocation" })
    const view = canvasElement.querySelector(
      '[data-slot="playground-run-traces"]'
    )!
    const currentTrace = view.querySelector('[aria-label="Run result"]')
    await userEvent.click(canvas.getByRole("button", { name: "Run" }))
    await waitFor(() => expect(typeof finishRun).toBe("function"))
    await expect(getComputedStyle(view).filter).toMatch(/blur/)
    await expect(view.querySelector('[aria-label="Run result"]')).toBe(
      currentTrace
    )
    finishRun!(data({ traceId: replacement.id }))
    await waitFor(() => expect(typeof finishTrace).toBe("function"))
    await expect(getComputedStyle(view).filter).toMatch(/blur/)
    await expect(view.querySelector('[aria-label="Run result"]')).toBe(
      currentTrace
    )
    await expect(view).toHaveTextContent("Invocation")
    finishTrace!()
    await canvas.findByRole("heading", { name: "Replacement result" })
    await expect(getComputedStyle(view).filter).toBe("none")
    await expect(view).not.toHaveTextContent("Invocation")
  },
}

export const RetainResultAfterRunFailure: Story = {
  ...RetainResultWhileRunning,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("heading", { name: "Invocation" })
    const view = canvasElement.querySelector(
      '[data-slot="playground-run-traces"]'
    )!
    const currentTrace = view.querySelector('[aria-label="Run result"]')
    await userEvent.click(canvas.getByRole("button", { name: "Run" }))
    await waitFor(() => expect(typeof finishRun).toBe("function"))
    await expect(getComputedStyle(view).filter).toMatch(/blur/)
    finishRun!(failure("Listener disconnected"))
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Listener disconnected"
    )
    await expect(getComputedStyle(view).filter).toBe("none")
    await expect(view.querySelector('[aria-label="Run result"]')).toBe(
      currentTrace
    )
    await expect(
      canvas.getByRole("heading", { name: "Invocation" })
    ).toBeVisible()
  },
}
