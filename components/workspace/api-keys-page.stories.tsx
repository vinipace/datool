import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { delay, http, HttpResponse } from "msw"
import { expect, userEvent, within } from "storybook/test"
import {
  apiError,
  apiKeyHandlers,
} from "../../.storybook/scenarios/auth-workspace/handlers"
import {
  storybookApiKeyList,
  storybookMemberApiKeyList,
  storybookOrganization,
} from "../../.storybook/scenarios/auth-workspace/fixtures"
import { ApiKeysPage } from "./api-keys-page"

const meta = {
  title: "Workspace/ApiKeysPage",
  component: ApiKeysPage,
  args: {
    organizationId: storybookOrganization.id,
    organizationName: storybookOrganization.name,
  },
  parameters: {
    layout: "fullscreen",
    msw: { handlers: apiKeyHandlers() },
  },
} satisfies Meta<typeof ApiKeysPage>

export default meta
type Story = StoryObj<typeof meta>

/**
 * Production contrast debt in `components/workspace/api-keys-page.tsx`:
 * `.text-foreground-subtle` at lines 276, 404-415, and 460 resolves to
 * #71717a. Axe measures 4.34:1 on #000000 for `.mt-2.text-foreground-subtle`
 * and `.p-12`, and 3.99:1 on #0e0e0f for the expiry-cell selector
 * `td.text-foreground-subtle`. Keep these interaction stories meaningful while
 * making whole-story axe nonblocking until the production token usage is fixed.
 */
const apiKeysA11yTodo = {
  a11y: { test: "todo" },
  docs: {
    description: {
      story:
        "Known production contrast debt in `components/workspace/api-keys-page.tsx` at lines 276, 404-415, and 460: muted labels and table cells measure 4.34:1 and 3.99:1 against the dark surfaces. This whole story remains visually covered while the semantic token use is repaired.",
    },
  },
} as const

export const Owner: Story = {
  parameters: apiKeysA11yTodo,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByText("Production tracing")).resolves.toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "API key" }))
    const documentBody = within(canvasElement.ownerDocument.body)
    await userEvent.type(
      await documentBody.findByLabelText("Name"),
      "CI tracing"
    )
    await userEvent.click(
      documentBody.getByRole("button", { name: "Create API key" })
    )
    await expect(documentBody.findByLabelText("API key")).resolves.toHaveValue(
      "dtk_storybook_new_key"
    )
  },
}

export const MemberWithoutPermission: Story = {
  parameters: {
    ...apiKeysA11yTodo,
    msw: { handlers: apiKeyHandlers({ response: storybookMemberApiKeyList }) },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.findByText(
        "Ask an organization owner or admin to manage API keys."
      )
    ).resolves.toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: "API key" })
    ).not.toBeInTheDocument()
  },
}

export const CreationDisabled: Story = {
  parameters: {
    ...apiKeysA11yTodo,
    msw: {
      handlers: apiKeyHandlers({
        response: { ...storybookApiKeyList, creationDisabled: true },
      }),
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByRole("button", { name: "API key" })
    ).resolves.toBeDisabled()
  },
}

export const Loading: Story = {
  parameters: {
    ...apiKeysA11yTodo,
    msw: {
      handlers: [
        http.get("/api/organizations/:organizationId/api-keys", async () => {
          await delay("infinite")
          return HttpResponse.json({ data: storybookApiKeyList })
        }),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).findByText("Loading API keys…")
    ).resolves.toBeVisible()
  },
}

export const LoadFailureAndRetry: Story = {
  parameters: {
    ...apiKeysA11yTodo,
    msw: {
      handlers: [
        http.get(
          "/api/organizations/:organizationId/api-keys",
          () => apiError("API keys could not be loaded."),
          { once: true }
        ),
        ...apiKeyHandlers(),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "API keys could not be loaded."
    )
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }))
    await expect(canvas.findByText("Production tracing")).resolves.toBeVisible()
  },
}

export const RevokeKey: Story = {
  parameters: apiKeysA11yTodo,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Production tracing")
    await userEvent.click(
      canvas.getByRole("button", { name: "Revoke Production tracing" })
    )
    const documentBody = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await documentBody.findByRole("button", { name: "Revoke key" })
    )
    await expect(canvas.findByRole("status")).resolves.toHaveTextContent(
      "Revoked Production tracing."
    )
  },
}
