import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import { http } from "msw"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import {
  data,
  datasetsEvalsHandlers,
  failure,
} from "../../.storybook/scenarios/datasets-evals/handlers"
import { list } from "../../.storybook/scenarios/datasets-evals/fixtures"
import { DatasetsPage } from "./dataset-library-page"

const meta = {
  title: "Tracer/Datasets/DatasetLibraryPage",
  component: DatasetsPage,
  parameters: {
    layout: "fullscreen",
    nextjs: { navigation: { pathname: "/p/demo/datasets" } },
  },
  render: () => (
    <StorybookProjectFrame title="Datasets">
      <DatasetsPage />
    </StorybookProjectFrame>
  ),
} satisfies Meta<typeof DatasetsPage>

export default meta
type Story = StoryObj<typeof meta>

export const Library: Story = {
  parameters: { msw: { handlers: datasetsEvalsHandlers } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("support")).resolves.toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: "Expand support" })
    )
    await expect(canvas.findByText("billing-faq")).resolves.toBeVisible()
  },
}

export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [http.get("/api/datasets/library", () => data(list([])))],
    },
    nextjs: {
      navigation: { pathname: "/p/demo-empty/datasets" },
    },
  },
  render: () => (
    <StorybookProjectFrame projectId="storybook-empty-library" title="Datasets">
      <DatasetsPage />
    </StorybookProjectFrame>
  ),
  play: async ({ canvasElement }) => {
    await userEvent.type(
      within(canvasElement).getByRole("textbox", {
        name: "Search datasets and folders",
      }),
      "billing"
    )
    await expect(
      within(canvasElement).findByText("No matching folders or datasets.")
    ).resolves.toBeVisible()
  },
}

export const LoadFailure: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("/api/datasets/library", () =>
          failure("Could not load the dataset library")
        ),
      ],
    },
    nextjs: {
      navigation: { pathname: "/p/demo-error/datasets" },
    },
  },
  render: () => (
    <StorybookProjectFrame projectId="storybook-error-library" title="Datasets">
      <DatasetsPage />
    </StorybookProjectFrame>
  ),
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("alert")
    ).resolves.toHaveTextContent("Could not load the dataset library")
  },
}
