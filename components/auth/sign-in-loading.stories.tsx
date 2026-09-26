import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { SignInLoading } from "./sign-in-loading"

const meta = {
  title: "Auth/SignInLoading",
  component: SignInLoading,
  parameters: {
    layout: "fullscreen",
    nextjs: { navigation: { pathname: "/sign-in", query: {} } },
  },
} satisfies Meta<typeof SignInLoading>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const ProOnboarding: Story = {
  parameters: {
    nextjs: {
      navigation: {
        pathname: "/sign-in",
        query: { callbackUrl: "/billing?plan=pro" },
      },
    },
  },
}
