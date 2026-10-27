import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"
import { ChannelLinkActivityContent } from "./channel-link-activity"

const meta = {
  title: "Build/ChannelLinkActivity",
  component: ChannelLinkActivityContent,
  args: {
    agentId: "preview-agent",
    loading: false,
    error: false,
    onRefresh: fn(),
    data: {
      items: [
        {
          token: "preview-product",
          destination:
            "https://store.example.com/products/the-inventory-not-tracked-snowboard",
          label: "The Inventory Not Tracked Snowboard",
          conversationId: "preview-conversation",
          clicks: 2,
          automatedVisits: 1,
          createdAt: "2026-10-27T16:00:00Z",
          lastClickedAt: "2026-10-27T16:05:00Z",
          expiresAt: "2027-01-25T16:00:00Z",
        },
        {
          token: "preview-checkout",
          destination: "https://store.example.com/cart/123:1",
          label: "Checkout",
          conversationId: "preview-conversation",
          clicks: 0,
          automatedVisits: 1,
          createdAt: "2026-10-27T16:02:00Z",
          lastClickedAt: null,
          expiresAt: "2027-01-25T16:02:00Z",
        },
      ],
    },
  },
  decorators: [
    (Story) => (
      <div className="max-w-3xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ChannelLinkActivityContent>
export default meta
type Story = StoryObj<typeof meta>
export const Activity: Story = {}
export const Empty: Story = { args: { data: { items: [] } } }
export const Loading: Story = { args: { data: null, loading: true } }
export const Error: Story = { args: { data: null, error: true } }
export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div className="w-80 max-w-full">
        <Story />
      </div>
    ),
  ],
}
