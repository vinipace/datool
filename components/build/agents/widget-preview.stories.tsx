import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, within } from "storybook/test"
import { widgetDefinitionSchema } from "@/src/lib/build/contracts"
import { WidgetPreview } from "./widget-preview"

const definition = widgetDefinitionSchema.parse({
  name: "Local widget controls",
  code: `import * as Shared from "@datool/widgets"
const ChoiceGroup = Shared.ChoiceGroup;
const DatePicker = Shared.DatePicker;
const Text = ({ children }) => <h3>{children}</h3>;
export default function Widget({ data }) {
  return <Col gap={12}>
    <Text>Choose a model and date</Text>
    <ChoiceGroup label="Models" options={data.models} value={[]} onChange={() => {}} multiple />
    <DatePicker label="Event date" value="" onChange={() => {}} />
  </Col>;
}`,
  schemaCode: `import { z } from "zod"
export default z.object({ models: z.array(z.object({ id: z.string(), label: z.string() })) });`,
  states: {
    default: { models: [{ id: "shirt", label: "Linen shirt" }] },
  },
})

const meta = {
  title: "Build/WidgetPreview",
  component: WidgetPreview,
  args: {
    definition,
    selectedState: "default",
    onStateChange: fn(),
  },
  render: (args) => (
    <div className="h-[700px] max-w-2xl">
      <WidgetPreview {...args} />
    </div>
  ),
} satisfies Meta<typeof WidgetPreview>
export default meta
type Story = StoryObj<typeof meta>

export const LocalComponentNames: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Check preview" }))
    await expect(await canvas.findByRole("status")).toHaveTextContent(
      "Preview checks passed. Review its appearance before saving."
    )
  },
}
