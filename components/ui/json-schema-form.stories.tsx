import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import {
  createTraceSchema,
  createTraceValue,
} from "@/.storybook/scenarios/ui/fixtures"
import type { JsonValue } from "@/src/lib/tracer/contracts"
import { JsonSchemaForm } from "./json-schema-form"

function SchemaPreview() {
  const [value, setValue] = React.useState<JsonValue>(() => createTraceValue())

  return (
    <div className="grid w-[34rem] max-w-full gap-4">
      <JsonSchemaForm
        name="Trace"
        schema={createTraceSchema()}
        value={value}
        onChange={setValue}
      />
      <output
        aria-label="Form value"
        className="rounded-md border border-border bg-muted p-3 font-mono text-xs"
      >
        {JSON.stringify(value)}
      </output>
    </div>
  )
}

const meta = {
  title: "UI/JsonSchemaForm",
  component: JsonSchemaForm,
  render: () => <SchemaPreview />,
} satisfies Meta<typeof JsonSchemaForm>

export default meta
type Story = StoryObj<typeof SchemaPreview>

export const StructuredFields: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = canvas.getByRole("textbox", { name: "Trace.name" })
    await userEvent.clear(input)
    await userEvent.type(input, "Invoice pipeline")
    await expect(canvas.getByLabelText("Form value")).toHaveTextContent(
      "Invoice pipeline"
    )
  },
}

export const JsonFallback: Story = {
  render: () => (
    <div className="w-[34rem] max-w-full">
      <JsonSchemaForm
        name="Trace tags"
        schema={{ type: "array", items: { type: "string" } }}
        value={["billing", "production"]}
        onChange={() => undefined}
      />
    </div>
  ),
}
