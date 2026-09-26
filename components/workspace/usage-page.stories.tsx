import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { http, HttpResponse, delay } from "msw"
import { expect, userEvent, within } from "storybook/test"
import { UsagePage, type OrganizationUsage } from "./usage-page"
import { SettingsShell } from "./settings-shell"

const organization = {
  id: "usage-team",
  name: "Datool demo",
  slug: "datool-demo",
}
const endpoint = "/api/organizations/usage-team/usage"
const data: OrganizationUsage = {
  plan: "pro",
  credits: {
    plan: "pro",
    periodStart: "2026-09-01T00:00:00Z",
    periodEnd: "2026-10-01T00:00:00Z",
    allowance: 25,
    used: 8.4,
    reserved: 0.6,
    remaining: 16,
    model: 6.8,
    sandbox: 1.6,
    pendingRuns: 2,
    projects: [
      {
        id: "support",
        name: "Support agent",
        model: 4.5,
        sandbox: 1.2,
        reserved: 0.4,
      },
      {
        id: "search",
        name: "Search assistant",
        model: 2.3,
        sandbox: 0.4,
        reserved: 0.2,
      },
    ],
  },
  records: {
    periodStart: "2026-09-01T00:00:00Z",
    periodEnd: "2026-10-01T00:00:00Z",
    traces: 126000,
    spans: 294000,
    used: 420000,
    limit: 1000000,
    remaining: 580000,
    percent: 42,
    retentionDays: 365,
  },
}
const orgs = http.get("/api/auth/organization/list", () =>
  HttpResponse.json([organization])
)
const meta = {
  title: "Workspace/UsagePage",
  component: UsagePage,
  args: { organization },
  decorators: [
    (Story) => (
      <SettingsShell
        title="Usage"
        backHref="/projects"
        organization={organization}
      >
        <Story />
      </SettingsShell>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    nextjs: { navigation: { pathname: "/usage" } },
    msw: {
      handlers: [orgs, http.get(endpoint, () => HttpResponse.json(data))],
    },
  },
} satisfies Meta<typeof UsagePage>
export default meta
type Story = StoryObj<typeof meta>
export const WithUsage: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByRole("progressbar", { name: "Execution credit usage" })
    ).resolves.toHaveAttribute("aria-valuenow", "9")
    await expect(
      canvas.getByRole("progressbar", { name: "Records" })
    ).toHaveAttribute("aria-valuenow", "420000")
    await expect(canvas.getByRole("link", { name: "Usage" })).toHaveAttribute(
      "aria-current",
      "page"
    )
    await userEvent.click(canvas.getByRole("button", { name: "Refresh" }))
    await expect(canvas.findByText("Support agent")).resolves.toBeVisible()
  },
}
export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [
        orgs,
        http.get(endpoint, () =>
          HttpResponse.json({
            ...data,
            credits: {
              ...data.credits,
              used: 0,
              reserved: 0,
              remaining: 25,
              model: 0,
              sandbox: 0,
              pendingRuns: 0,
              projects: [],
            },
          })
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText(/No funded runs this period/)
    ).resolves.toBeVisible()
  },
}
export const Exhausted: Story = {
  parameters: {
    msw: {
      handlers: [
        orgs,
        http.get(endpoint, () =>
          HttpResponse.json({
            ...data,
            credits: {
              ...data.credits,
              used: 25,
              reserved: 0,
              remaining: 0,
              model: 20,
              sandbox: 5,
              pendingRuns: 0,
              projects: [
                {
                  id: "support",
                  name: "Support agent",
                  model: 20,
                  sandbox: 5,
                  reserved: 0,
                },
              ],
            },
          })
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText(/Your execution credits are fully used/)
    ).resolves.toBeVisible()
  },
}
export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        orgs,
        http.get(endpoint, async () => {
          await delay("infinite")
          return HttpResponse.json(data)
        }),
      ],
    },
  },
}
export const Error: Story = {
  parameters: {
    msw: {
      handlers: [
        orgs,
        http.get(endpoint, () =>
          HttpResponse.json(
            { error: { message: "Unable to load organization usage." } },
            { status: 503 }
          )
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "Unable to load"
    )
    await expect(
      canvas.getByRole("button", { name: "Retry usage" })
    ).toBeEnabled()
  },
}
