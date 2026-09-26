import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { Notice, NoticeDescription, NoticeTitle } from "./notice"

const meta = {
  title: "UI/Notice",
  component: Notice,
  render: () => (
    <div className="grid w-[34rem] max-w-full gap-3">
      <Notice title="Trace capture is ready">
        Send an invocation to begin recording data.
      </Notice>
      <Notice variant="info" title="Retention policy">
        <NoticeDescription>
          Trace data is retained for 30 days.
        </NoticeDescription>
      </Notice>
      <Notice variant="success">
        <NoticeTitle>Dataset saved</NoticeTitle>
        <NoticeDescription>
          Your changes are available to evaluators.
        </NoticeDescription>
      </Notice>
      <Notice variant="warning" title="Missing evaluator">
        Attach an evaluator before running this comparison.
      </Notice>
      <Notice variant="error" title="Could not save">
        Check the connection and try again.
      </Notice>
    </div>
  ),
} satisfies Meta<typeof Notice>

export default meta
type Story = StoryObj<typeof meta>

export const Variants: Story = {}
