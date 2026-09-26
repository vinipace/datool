import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { createTraceValue } from "@/.storybook/scenarios/ui/fixtures"
import { StructuredValueView, ValueTree } from "./structured-value-view"

function StructuredValueGallery() {
  const value = createTraceValue()
  return (
    <div className="grid w-[42rem] max-w-full gap-6">
      <section className="grid gap-2">
        <h2 className="text-sm font-medium">Pretty JSON</h2>
        <StructuredValueView value={value} view="pretty" />
      </section>
      <section className="grid gap-2">
        <h2 className="text-sm font-medium">YAML</h2>
        <StructuredValueView value={value} view="yaml" />
      </section>
      <section className="grid gap-2">
        <h2 className="text-sm font-medium">Tree</h2>
        <ValueTree value={value} />
      </section>
    </div>
  )
}

const meta = {
  title: "UI/StructuredValueView",
  component: StructuredValueView,
  render: () => <StructuredValueGallery />,
} satisfies Meta<typeof StructuredValueView>

export default meta
type Story = StoryObj<typeof StructuredValueGallery>

export const Formats: Story = {}

export const CompactJson: Story = {
  render: () => (
    <StructuredValueView compact value={createTraceValue()} view="json" />
  ),
}

export const Image: Story = {
  render: () => (
    <StructuredValueView
      view="image"
      value={{
        type: "image",
        url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6CBwAAAAASUVORK5CYII=",
      }}
    />
  ),
}
