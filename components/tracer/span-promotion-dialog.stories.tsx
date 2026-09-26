import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, within, waitFor } from "storybook/test"
import { http, HttpResponse, delay } from "msw"
import { SpanPromotionDialog } from "./span-promotion-dialog"

const meta = {
  title: "Tracer/Datasets/SpanPromotionDialog",
  component: SpanPromotionDialog,
  args: { traceId: "trace-source", spanId: "span-source", onClose: fn() },
  parameters: {
    layout: "fullscreen",
    nextjs: {
      appDirectory: true,
      navigation: { pathname: "/p/demo/traces/trace-source" },
    },
  },
} satisfies Meta<typeof SpanPromotionDialog>
export default meta
type Story = StoryObj<typeof meta>
const datasetHandler = http.get("/api/datasets", () =>
  HttpResponse.json({
    data: {
      items: [{ id: "ds-cases", name: "Production cases" }],
      nextCursor: null,
    },
  })
)
const promotionHandler = http.post(
  "/api/agent/promote_spans",
  async ({ request }) => {
    const input = (await request.json()) as {
      preview: boolean
      spans: { mappedInput?: unknown; copyObservedOutput: boolean }[]
    }
    await delay(100)
    return HttpResponse.json({
      data: {
        preview: input.preview,
        datasetId: "ds-cases",
        evidenceHash: "hash",
        created: input.preview ? [] : ["item"],
        cases: [
          {
            input: input.spans[0].mappedInput ?? {
              messages: [{ role: "user", content: "Acme sells shoes." }],
            },
            expectedOutput: input.spans[0].copyObservedOutput
              ? { brands: ["Acme"] }
              : null,
            observedOutput: { brands: ["Acme"] },
            sourceSpanEvidence: {
              input: {
                messages: [{ role: "user", content: "Acme sells shoes." }],
              },
              spans: [{ id: "span-source" }],
              startedAt: "2026-09-18T12:00:00Z",
            },
          },
        ],
      },
    })
  }
)
export const PreviewAndSave: Story = {
  parameters: { msw: { handlers: [datasetHandler, promotionHandler] } },
  play: async () => {
    const body = within(document.body)
    const picker = await body.findByRole("combobox", { name: "Dataset" })
    await waitFor(() => expect(picker).not.toBeDisabled())
    await userEvent.click(picker)
    await userEvent.click(
      await body.findByRole("option", { name: "Production cases" })
    )
    await userEvent.click(body.getByRole("button", { name: "Preview case" }))
    await body.findByRole("button", { name: "Save case" })
    await expect(
      body.getByRole("checkbox", {
        name: "Use observed output as the reference answer",
      })
    ).not.toBeChecked()
    await expect(body.getByText("Observed output (unreviewed)")).toBeVisible()
    await userEvent.click(body.getByRole("button", { name: "Save case" }))
    await expect(
      body.findByRole("link", { name: "Open dataset" })
    ).resolves.toBeVisible()
  },
}
export const EmptyDatasets: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/datasets", () =>
          HttpResponse.json({ data: { items: [], nextCursor: null } })
        ),
      ],
    },
  },
}
export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/datasets", async () => {
          await delay("infinite")
          return HttpResponse.json({ data: {} })
        }),
      ],
    },
  },
}
export const LoadFailure: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/datasets", () =>
          HttpResponse.json(
            { error: { message: "Datasets could not be loaded." } },
            { status: 503 }
          )
        ),
      ],
    },
  },
}
