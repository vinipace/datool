import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { getRouter } from "@storybook/nextjs-vite/navigation.mock"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { http, delay, HttpResponse } from "msw"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import {
  data,
  failure,
  datasetsEvalsHandlers,
} from "../../.storybook/scenarios/datasets-evals/handlers"
import { ConnectedEvalButton } from "./connected-eval-button"
import {
  evaluators,
  evalRun,
  list,
} from "../../.storybook/scenarios/datasets-evals/fixtures"
import { libraryScorerPreset } from "@/src/lib/tracer/scorers"

const submittedRun = fn()

async function overridesEditor() {
  const input = await within(document.body).findByRole(
    "textbox",
    { name: "Input overrides" },
    { timeout: 10000 }
  )
  const { monaco } = await import("./monaco-runtime")
  const editor = monaco.editor
    .getEditors()
    .find((item) => item.getDomNode()?.contains(input))!
  return { input, editor, monaco }
}

async function editOverrides(text: string) {
  const { input, editor } = await overridesEditor()
  await userEvent.click(input)
  editor.trigger("storybook", "editor.action.selectAll", undefined)
  await userEvent.paste(text)
  await waitFor(() => expect(editor.getValue()).toBe(text))
  return editor
}

const meta = {
  title: "Tracer/Evals/ConnectedEvalButton",
  component: ConnectedEvalButton,
  parameters: {
    nextjs: { navigation: { pathname: "/p/demo/evals" } },
  },
  beforeEach: () => {
    submittedRun.mockClear()
    getRouter().push.mockClear()
  },
  render: (args) => (
    <StorybookProjectFrame title="Evaluation runs">
      <div className="p-3">
        <ConnectedEvalButton {...args} />
      </div>
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof ConnectedEvalButton>

export default meta
type Story = StoryObj<typeof meta>

export const ReadyToRun: Story = {
  parameters: { msw: { handlers: datasetsEvalsHandlers } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Run dataset" }))
    const dialog = within(document.body)
    await expect(
      dialog.findByText("Run dataset against an app")
    ).resolves.toBeVisible()
    const appSelect = dialog.getByRole("combobox", { name: "App" })
    await waitFor(() => expect(appSelect).toBeEnabled())
    await userEvent.click(appSelect)
    await userEvent.click(
      await dialog.findByRole("option", { name: "Invoice assistant" })
    )
    await expect(appSelect).toHaveTextContent("Invoice assistant")
    const datasetSelect = dialog.getByRole("combobox", { name: "Dataset" })
    await userEvent.click(datasetSelect)
    const datasetOption = await dialog.findByRole("option", {
      name: "support/billing-faq",
    })
    await expect(
      datasetOption.querySelector("svg.text-resource-dataset-foreground")
    ).toBeVisible()
    await userEvent.click(datasetOption)
    await expect(datasetSelect).toHaveTextContent("support/billing-faq")
    await expect(
      datasetSelect.querySelector("svg.text-resource-dataset-foreground")
    ).toBeVisible()
    await userEvent.click(datasetSelect)
    await userEvent.keyboard("{Escape}")
    await expect(datasetSelect).toHaveFocus()
    await expect(dialog.getByRole("dialog")).toBeVisible()
    await userEvent.click(dialog.getByRole("combobox", { name: "Scorers" }))
    await userEvent.click(
      await dialog.findByRole("option", { name: /Answer groundedness/ })
    )
    await userEvent.keyboard("{Escape}")
    await expect(dialog.getByRole("dialog")).toBeVisible()
    await expect(
      dialog.getByRole("combobox", { name: "Scorers" })
    ).toHaveFocus()
    await expect(
      dialog.getByRole("button", { name: "Run app and score traces" })
    ).toBeEnabled()
  },
}

export const CatalogFailure: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/apps/config", () =>
          failure("App catalog is unavailable")
        ),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Run dataset" })
    )
    await expect(
      within(within(document.body).getByRole("dialog")).findByRole("alert")
    ).resolves.toHaveTextContent("App catalog is unavailable")
  },
}

export const InputOverrides: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post("/api/evals", async ({ request }) => {
          const body = (await request.json()) as { inputOverrides: unknown }
          return HttpResponse.json(
            {
              error: {
                message: `Received ${JSON.stringify(body.inputOverrides)}`,
              },
            },
            { status: 400 }
          )
        }),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  play: async (context) => {
    await ReadyToRun.play!(context)
    const dialog = within(within(document.body).getByRole("dialog"))
    await editOverrides("invalid")
    await expect(dialog.getAllByRole("alert")).toHaveLength(1)
    await expect(
      dialog.getByRole("button", { name: "Run app and score traces" })
    ).toBeDisabled()
    await editOverrides("[]")
    await waitFor(() =>
      expect(dialog.getByRole("alert")).toHaveTextContent("must be an object")
    )
    await expect(
      dialog.getByRole("button", { name: "Run app and score traces" })
    ).toBeDisabled()
    const editor = await editOverrides(
      '{"model":"test-model","promptVersion":2}'
    )
    await waitFor(() =>
      expect(dialog.queryByRole("alert")).not.toBeInTheDocument()
    )
    await userEvent.click(
      dialog.getByRole("button", { name: "Run app and score traces" })
    )
    await expect(dialog.findByRole("alert")).resolves.toHaveTextContent(
      'Received {"model":"test-model","promptVersion":2}'
    )
    await expect(JSON.parse(editor.getValue())).toEqual({
      model: "test-model",
      promptVersion: 2,
    })
    await userEvent.keyboard("{Escape}")
    await expect(
      within(context.canvasElement).getByRole("button", { name: "Run dataset" })
    ).toHaveFocus()
  },
}

export const CatalogLoading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/apps/config", async () => {
          await delay("infinite")
          return data([])
        }),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Run dataset" })
    )
    await expect(
      within(document.body).getByText("Loading apps and datasets…")
    ).toBeVisible()
    await expect(within(document.body).getByLabelText("App")).toBeDisabled()
  },
}

export const EmptyCatalog: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/apps/config", () => data([])),
        http.get("/api/apps", () => data([])),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Run dataset" })
    )
    await expect(
      within(document.body).findByText(
        "Add an app and dataset to run an evaluation."
      )
    ).resolves.toBeVisible()
  },
}

export const ManagedPromptOverrides: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post("/api/evals", async ({ request }) => {
          const body = (await request.json()) as { promptOverrides: unknown }
          return failure(`Received ${JSON.stringify(body.promptOverrides)}`)
        }),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  play: async (context) => {
    await ReadyToRun.play!(context)
    const dialog = within(document.body)
    const promptSelect = dialog.getByRole("combobox", {
      name: "Add prompt override",
    })
    await userEvent.click(promptSelect)
    await userEvent.click(
      await dialog.findByRole("option", { name: "Brand extraction" })
    )
    await expect(promptSelect).toHaveTextContent("Choose published prompt")
    await userEvent.type(
      dialog.getByLabelText("Version for brand-extraction"),
      "2"
    )
    await userEvent.click(
      dialog.getByRole("button", { name: "Run app and score traces" })
    )
    await expect(dialog.findByRole("alert")).resolves.toHaveTextContent(
      'Received {"brand-extraction":{"version":2}}'
    )
    await userEvent.click(
      dialog.getByRole("button", { name: "Remove brand-extraction override" })
    )
    await expect(
      dialog.queryByLabelText("Version for brand-extraction")
    ).not.toBeInTheDocument()
    await expect(promptSelect).toBeEnabled()
    await userEvent.keyboard("{Escape}")
    await expect(
      within(context.canvasElement).getByRole("button", { name: "Run dataset" })
    ).toHaveFocus()
  },
}

export const LibraryScorerWithoutProjectScorers: Story = {
  args: {
    appId: "app-storybook-support",
    datasetId: "dataset-storybook-support",
  },
  parameters: {
    msw: {
      handlers: [
        http.get("/api/evaluators", () => data(list([]))),
        http.post("/api/scorers/libraries", async ({ request }) => {
          const body = await request.json()
          if ((body as { evaluator: string }).evaluator !== "ExactMatch")
            return failure("Unexpected library scorer")
          const config = libraryScorerPreset("ExactMatch")
          return data({
            ...evaluators[0],
            id: "library-exact-match",
            name: config.name,
            activeVersion: {
              ...evaluators[0].activeVersion,
              evaluatorId: "library-exact-match",
              config,
            },
          })
        }),
        http.post("/api/evals", async ({ request }) => {
          submittedRun(await request.json())
          return data(evalRun)
        }),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Run dataset" })
    )
    const page = within(document.body)
    const picker = page.getByRole("combobox", { name: "Scorers" })
    await waitFor(() => expect(picker).toBeEnabled())
    await userEvent.click(picker)
    await userEvent.type(picker, "Exact match")
    await userEvent.click(
      await page.findByRole("option", { name: /Exact match/ })
    )
    await waitFor(() =>
      expect(
        page.getByRole("button", { name: "Run app and score traces" })
      ).toBeEnabled()
    )
    await userEvent.click(
      page.getByRole("heading", { name: "Run dataset against an app" })
    )
    await userEvent.click(
      page.getByRole("button", { name: "Run app and score traces" })
    )
    await waitFor(() =>
      expect(submittedRun).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "connected",
          appId: "app-storybook-support",
          datasetId: "dataset-storybook-support",
          evaluatorIds: ["library-exact-match"],
        })
      )
    )
    await expect(submittedRun.mock.calls[0][0]).not.toHaveProperty(
      "inputOverrides"
    )
    await waitFor(() =>
      expect(getRouter().push).toHaveBeenCalledWith(
        `/p/demo/evals/${evalRun.id}`
      )
    )
    await expect(page.queryByRole("dialog")).not.toBeInTheDocument()
  },
}

export const YamlInputOverrides: Story = {
  parameters: InputOverrides.parameters,
  play: async (context) => {
    await ReadyToRun.play!(context)
    const page = within(document.body)
    await editOverrides(
      '{"locale":"pt-BR","options":{"verbose":true},"tags":["test"],"fallback":null}'
    )
    await userEvent.click(
      page.getByRole("combobox", { name: "Input overrides format" })
    )
    await userEvent.click(await page.findByRole("option", { name: "YAML" }))
    const { editor } = await overridesEditor()
    await expect(editor.getModel()?.getLanguageId()).toBe("yaml")
    await expect(editor.getValue()).toContain("locale: pt-BR")
    await editOverrides(
      "locale: en-US\noptions:\n  verbose: false\ntags: [updated]\nfallback: null\n"
    )
    await userEvent.click(
      page.getByRole("combobox", { name: "Input overrides format" })
    )
    await userEvent.click(await page.findByRole("option", { name: "JSON" }))
    const json = await overridesEditor()
    await expect(json.editor.getModel()?.getLanguageId()).toBe("json")
    await expect(JSON.parse(json.editor.getValue())).toEqual({
      locale: "en-US",
      options: { verbose: false },
      tags: ["updated"],
      fallback: null,
    })
    await userEvent.click(
      page.getByRole("button", { name: "Run app and score traces" })
    )
    await expect(page.findByRole("alert")).resolves.toHaveTextContent(
      'Received {"locale":"en-US","options":{"verbose":false},"tags":["updated"],"fallback":null}'
    )
  },
}

export const StartingRun: Story = {
  parameters: {
    msw: {
      handlers: [
        http.post("/api/evals", async () => {
          await delay("infinite")
        }),
        ...datasetsEvalsHandlers,
      ],
    },
  },
  play: async (context) => {
    await ReadyToRun.play!(context)
    const { editor, monaco } = await overridesEditor()
    const page = within(document.body)
    await userEvent.click(
      page.getByRole("button", { name: "Run app and score traces" })
    )
    await expect(page.getByRole("button", { name: "Starting…" })).toBeDisabled()
    await expect(page.getByRole("combobox", { name: "Scorers" })).toBeDisabled()
    await expect(
      page.getByRole("combobox", { name: "Input overrides format" })
    ).toBeDisabled()
    await expect(
      page.getByRole("button", { name: "Format Input overrides" })
    ).toBeDisabled()
    await waitFor(() =>
      expect(editor.getOption(monaco.editor.EditorOption.readOnly)).toBe(true)
    )
  },
}
