import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { http, HttpResponse } from "msw"
import { expect, userEvent, within } from "storybook/test"
import { StorybookProjectFrame } from "../../../.storybook/component-frame"
import { DriveVersions } from "./drive-versions"
const head = "00000000-0000-4000-8000-000000000001"
const old = "00000000-0000-4000-8000-000000000002"
const meta = {
  title: "Build/Drive versions",
  component: DriveVersions,
  args: {
    drive: {
      id: "00000000-0000-4000-8000-000000000003",
      name: "Research",
      description: "",
      provider: "s3",
      createdAt: "2026-11-11T12:00:00Z",
      revision: head,
    },
    onClose: () => {},
  },
  decorators: [
    (Story) => (
      <StorybookProjectFrame>
        <Story />
      </StorybookProjectFrame>
    ),
  ],
  parameters: {
    msw: {
      handlers: [
        http.post("*/api/build/build_list_drive_versions", () =>
          HttpResponse.json({
            data: {
              items: [
                {
                  id: head,
                  createdAt: "2026-11-11T12:00:00Z",
                  files: 3,
                  bytes: 900,
                  current: true,
                },
                {
                  id: old,
                  createdAt: "2026-11-10T12:00:00Z",
                  files: 2,
                  bytes: 300,
                  current: false,
                },
              ],
            },
          })
        ),
        http.post(
          "*/api/build/build_restore_drive_version",
          async ({ request }) => {
            const body = await request.json()
            expect(body).toMatchObject({
              versionId: old,
              expectedRevision: head,
            })
            return HttpResponse.json(
              {
                error: {
                  message: "The drive changed. Reload before restoring.",
                },
              },
              { status: 409 }
            )
          }
        ),
      ],
    },
  },
} satisfies Meta<typeof DriveVersions>
export default meta
type Story = StoryObj<typeof meta>
export const History: Story = {}
export const StaleRestore: Story = {
  play: async () => {
    const dialog = within(await within(document.body).findByRole("dialog"))
    const buttons = await dialog.findAllByRole("button", { name: "Restore" })
    await userEvent.click(buttons[1])
    await expect(
      dialog.getByText(/This replaces the current files/)
    ).toBeVisible()
    await userEvent.click(
      dialog.getByRole("button", { name: "Restore version" })
    )
    await expect(dialog.findByRole("alert")).resolves.toHaveTextContent(
      "drive changed"
    )
  },
}
