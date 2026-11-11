import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { http, HttpResponse, delay } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { StorybookProjectFrame } from "../../.storybook/component-frame"
import { StorageProviderSettings } from "./storage-provider-settings"
import type {
  StorageConnection,
  StorageConnectionInput,
} from "@/src/lib/build/storage"
const path = "/api/projects/storage-test/storage-connections"
const connection: StorageConnection = {
  id: "00000000-0000-4000-8000-000000000011",
  name: "Customer files",
  config: {
    provider: "s3",
    bucket: "customer-files",
    prefix: "datool",
    region: "us-east-1",
  },
  revision: 1,
  createdAt: "2026-11-11T12:00:00Z",
}
let items: StorageConnection[] = []
let submitted: StorageConnectionInput | null = null
let failSave = false
const handlers = [
  http.get(path, () => HttpResponse.json({ items })),
  http.put(path, async ({ request }) => {
    submitted = (await request.json()) as StorageConnectionInput
    if (failSave)
      return HttpResponse.json(
        {
          error: {
            message: "Storage could not be verified. Check the credentials.",
          },
        },
        { status: 400 }
      )
    items = [{ ...connection, name: submitted.name, config: submitted.config }]
    return HttpResponse.json({ items })
  }),
]
const meta = {
  title: "Workspace/Storage providers",
  component: StorageProviderSettings,
  args: { projectId: "storage-test", canManage: true },
  beforeEach: () => {
    items = []
    submitted = null
    failSave = false
  },
  decorators: [
    (Story) => (
      <StorybookProjectFrame projectId="storage-test" title="Storage providers">
        <Story />
      </StorybookProjectFrame>
    ),
  ],
  parameters: { layout: "fullscreen", msw: { handlers } },
} satisfies Meta<typeof StorageProviderSettings>
export default meta
type Story = StoryObj<typeof meta>
export const LocalOnly: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("Local volumes")).resolves.toBeVisible()
    await expect(canvas.getByText("Not required")).toBeVisible()
  },
}
export const Configured: Story = {
  beforeEach: () => {
    items = [connection]
  },
}
export const Member: Story = {
  args: { canManage: false },
  beforeEach: () => {
    items = [connection]
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("Customer files")).resolves.toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: "Add storage provider" })
    ).not.toBeInTheDocument()
    await expect(
      canvas.queryByRole("button", { name: "Edit Customer files" })
    ).not.toBeInTheDocument()
  },
}
export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get(path, async () => {
          await delay("infinite")
          return HttpResponse.json({ items: [] })
        }),
      ],
    },
  },
}
export const Unavailable: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get(path, () =>
          HttpResponse.json(
            { error: { message: "Storage settings could not be loaded." } },
            { status: 503 }
          )
        ),
      ],
    },
  },
}
export const ConfigureAndRetry: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const add = await canvas.findByRole("button", {
      name: "Add storage provider",
    })
    await waitFor(() => expect(add).toBeEnabled())
    await userEvent.click(add)
    const dialog = within(await within(document.body).findByRole("dialog"))
    await userEvent.type(dialog.getByLabelText("Name"), "S3 archive")
    await userEvent.type(dialog.getByLabelText("Bucket"), "customer-files")
    await userEvent.type(dialog.getByLabelText("Access key ID"), "access-id")
    await userEvent.type(
      dialog.getByLabelText("Secret access key"),
      "temporary-test-secret"
    )
    failSave = true
    await userEvent.click(
      dialog.getByRole("button", { name: "Verify and save" })
    )
    await expect(dialog.findByRole("alert")).resolves.toHaveTextContent(
      "could not be verified"
    )
    failSave = false
    await userEvent.click(
      dialog.getByRole("button", { name: "Verify and save" })
    )
    await expect(canvas.findByText("S3 archive")).resolves.toBeVisible()
    expect(submitted).toMatchObject({
      config: { provider: "s3", bucket: "customer-files", region: "us-east-1" },
      credentials: {
        accessKeyId: "access-id",
        secretAccessKey: "temporary-test-secret",
      },
    })
    await userEvent.click(
      canvas.getByRole("button", { name: "Edit S3 archive" })
    )
    const edit = within(await within(document.body).findByRole("dialog"))
    await expect(edit.getByLabelText("Bucket")).toHaveAttribute("readonly")
    await expect(
      edit.queryByLabelText("Secret access key")
    ).not.toBeInTheDocument()
    await userEvent.click(edit.getByRole("button", { name: "Verify and save" }))
    await expect(canvas.findByText("S3 archive")).resolves.toBeVisible()
    expect(submitted?.credentials).toBeUndefined()
  },
}
export const GoogleCloud: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const add = await canvas.findByRole("button", {
      name: "Add storage provider",
    })
    await waitFor(() => expect(add).toBeEnabled())
    await userEvent.click(add)
    const dialog = within(await within(document.body).findByRole("dialog"))
    await userEvent.selectOptions(dialog.getByLabelText("Provider"), "gcs")
    await userEvent.type(dialog.getByLabelText("Name"), "GCS files")
    await userEvent.type(dialog.getByLabelText("Bucket"), "google-files")
    await userEvent.type(
      dialog.getByLabelText("Google Cloud project"),
      "my-project"
    )
    await userEvent.type(
      dialog.getByLabelText("Service account email"),
      "drive@example.iam.gserviceaccount.com"
    )
    await userEvent.type(
      dialog.getByLabelText("Private key"),
      "test-only-private-key"
    )
    await userEvent.click(
      dialog.getByRole("button", { name: "Verify and save" })
    )
    await expect(canvas.findByText("GCS files")).resolves.toBeVisible()
    expect(submitted).toMatchObject({
      config: {
        provider: "gcs",
        projectId: "my-project",
        bucket: "google-files",
      },
      credentials: {
        clientEmail: "drive@example.iam.gserviceaccount.com",
        privateKey: "test-only-private-key",
      },
    })
  },
}
