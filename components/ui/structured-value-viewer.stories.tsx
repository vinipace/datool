import * as React from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { StructuredValueViewer } from "./structured-value-viewer"
import { Button } from "./button"

const output = {
  messages: [
    {
      role: "assistant",
      content: "The trip takes **15 minutes**.",
      tool_calls: [
        {
          id: "call-1",
          function: {
            name: "estimateRoute",
            arguments: '{"from":"Ibirapuera","to":"Demo Garden Cafe"}',
          },
        },
      ],
    },
  ],
  cached: false,
}

function Payloads() {
  return (
    <div className="w-[42rem] max-w-full space-y-4">
      <section className="border-t border-border pt-2">
        <h2 className="text-sm text-foreground-muted">Input</h2>
        <StructuredValueViewer
          label="Input"
          value={{
            messages: [
              { role: "user", content: "How long to get to Demo Garden Cafe?" },
            ],
          }}
        />
      </section>
      <section className="border-t border-border pt-2">
        <h2 className="text-sm text-foreground-muted">Output</h2>
        <StructuredValueViewer label="Output" value={output} />
      </section>
    </div>
  )
}

const meta = {
  title: "UI/StructuredValueViewer",
  component: StructuredValueViewer,
  render: () => <Payloads />,
} satisfies Meta<typeof StructuredValueViewer>
export default meta
type Story = StoryObj<typeof Payloads>

export const MessageViews: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    const outputPicker = canvas.getByRole("combobox", {
      name: "Output view type",
    })
    await expect(
      canvas.getByRole("combobox", { name: "Input view type" })
    ).toHaveTextContent("LLM")
    await expect(canvas.getByText("15 minutes")).toHaveProperty(
      "tagName",
      "STRONG"
    )
    await userEvent.click(outputPicker)
    await userEvent.click(await page.findByRole("option", { name: "LLM Raw" }))
    await expect(
      canvas.getByText("The trip takes **15 minutes**.")
    ).toBeVisible()
    await userEvent.click(outputPicker)
    await userEvent.click(await page.findByRole("option", { name: "YAML" }))
    await expect(
      canvasElement.querySelector('[data-language="yaml"]')
    ).toHaveTextContent("cached: false")
    await expect(
      canvas.getByRole("combobox", { name: "Input view type" })
    ).toHaveTextContent("LLM")
    await userEvent.click(outputPicker)
    await expect(page.findByRole("listbox")).resolves.toBeVisible()
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(outputPicker).toHaveFocus())
  },
}

export const PrimitiveValues: Story = {
  render: () => (
    <div className="w-[42rem] max-w-full space-y-4">
      {["A plain string", "", 0, false, null].map((value, index) => (
        <StructuredValueViewer
          key={index}
          label={`Value ${index}`}
          value={value}
        />
      ))}
    </div>
  ),
}

export const HermesMessages: Story = {
  render: () => (
    <div className="w-[42rem] max-w-full space-y-4">
      <section aria-label="Hermes input">
        <StructuredValueViewer
          label="Input"
          value={{
            method: "POST",
            body: {
              model: "gpt-6-luna",
              messages: [
                { role: "system", content: "Use the terminal." },
                { role: "user", content: "Add **17 and 25**." },
                { role: "assistant", content: "I will read the result." },
                { role: "tool", tool_call_id: "call-1", content: "42" },
              ],
              max_completion_tokens: 2000,
            },
          }}
        />
      </section>
      <section aria-label="Hermes output">
        <StructuredValueViewer
          label="Output"
          value={{
            model: "gpt-6-luna",
            finish_reason: "tool_calls",
            assistant_message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-2",
                  name: "terminal",
                  arguments: '{"command":"cat result.txt"}',
                  provider_data: null,
                },
              ],
            },
            usage: { prompt_tokens: 4258, output_tokens: 74 },
          }}
        />
      </section>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    const input = within(canvas.getByRole("region", { name: "Hermes input" }))
    const outputElement = canvas.getByRole("region", { name: "Hermes output" })
    const output = within(outputElement)
    await expect(
      input.getByRole("combobox", { name: "Input view type" })
    ).toHaveTextContent("LLM")
    await expect(input.getByText("17 and 25")).toHaveProperty(
      "tagName",
      "STRONG"
    )
    await expect(input.getByText("42", { exact: true })).toBeVisible()
    const picker = output.getByRole("combobox", { name: "Output view type" })
    await expect(picker).toHaveTextContent("LLM")
    await expect(output.queryByText("Captured content")).not.toBeInTheDocument()
    await expect(
      output.queryByRole("textbox", { name: "terminal arguments" })
    ).not.toBeInTheDocument()
    await userEvent.click(output.getByText("terminal", { exact: true }))
    const editor = await waitFor(
      () => output.getByRole("textbox", { name: "terminal arguments" }),
      { timeout: 10_000 }
    )
    const { monaco } = await import("@/components/tracer/monaco-runtime")
    const instance = monaco.editor
      .getEditors()
      .find((item) => item.getDomNode()?.contains(editor))!
    await expect(instance.getModel()?.getLanguageId()).toBe("json")
    await expect(instance.getValue()).toBe(
      '{\n  "command": "cat result.txt"\n}'
    )
    await expect(instance.getOption(monaco.editor.EditorOption.readOnly)).toBe(
      true
    )
    await userEvent.click(editor)
    await userEvent.paste("changed")
    await expect(instance.getValue()).toBe(
      '{\n  "command": "cat result.txt"\n}'
    )
    await userEvent.click(output.getByText("terminal", { exact: true }))
    await waitFor(() =>
      expect(
        output.queryByRole("textbox", { name: "terminal arguments" })
      ).not.toBeInTheDocument()
    )
    await userEvent.click(picker)
    await userEvent.click(await page.findByRole("option", { name: /^JSON$/ }))
    await expect(
      outputElement.querySelector('[data-language="json"]')
    ).toHaveTextContent('"prompt_tokens": 4258')
    await expect(
      outputElement.querySelector('[data-language="json"]')
    ).toHaveTextContent('"assistant_message"')
    await userEvent.click(picker)
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(picker).toHaveFocus())
  },
}

export const TruncatedToolArguments: Story = {
  render: () => (
    <StructuredValueViewer
      label="Output"
      value={{
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "truncated",
                function: {
                  name: "terminal",
                  arguments: '{"command":"cat [truncated]',
                },
              },
            ],
          },
        ],
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByText("terminal", { exact: true }))
    const editor = await waitFor(
      () => canvas.getByRole("textbox", { name: "terminal arguments" }),
      { timeout: 10_000 }
    )
    const { monaco } = await import("@/components/tracer/monaco-runtime")
    const instance = monaco.editor
      .getEditors()
      .find((item) => item.getDomNode()?.contains(editor))!
    await expect(instance.getModel()?.getLanguageId()).toBe("plaintext")
    await expect(instance.getValue()).toBe('{"command":"cat [truncated]')
  },
}

export const ToolResults: Story = {
  render: () => <div className="w-[42rem] max-w-full">
    <StructuredValueViewer label="Conversation" value={{ messages: [
      { role: "user", content: "Read the numbers, then test an intentional failure." },
      { role: "assistant", content: null, tool_calls: [
        { id: "success", function: { name: "terminal", arguments: '{"command":"cat numbers.txt"}' } },
        { id: "failure", function: { name: "terminal", arguments: '{"command":"exit 7"}' } },
      ] },
      { role: "tool", tool_call_id: "failure", content: '{"output":"EXPECTED_FAILURE","exit_code":7,"error":null}' },
      { role: "tool", tool_call_id: "success", content: '{"output":"42","exit_code":0,"error":null}' },
      { role: "assistant", content: "The sum is 42; the intentional failure exited with code 7." },
    ] }} />
  </div>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getAllByRole("article")).toHaveLength(3)
    const cards = [...canvasElement.querySelectorAll("details")]
    await expect(cards).toHaveLength(2)
    const { monaco } = await import("@/components/tracer/monaco-runtime")
    for (const [index, card] of cards.entries()) {
      const scoped = within(card)
      await userEvent.click(scoped.getByText("terminal", { exact: true }))
      const output = await waitFor(() => scoped.getByRole("textbox", { name: "terminal result" }), { timeout: 10_000 })
      const input = scoped.getByRole("textbox", { name: "terminal arguments" })
      const instance = monaco.editor.getEditors().find(editor => editor.getDomNode()?.contains(output))!
      await expect(instance.getModel()?.getLanguageId()).toBe("json")
      await expect(instance.getOption(monaco.editor.EditorOption.readOnly)).toBe(true)
      const expected = { output: index ? "EXPECTED_FAILURE" : "42", exit_code: index ? 7 : 0, error: null }
      await expect(instance.getValue()).toBe(JSON.stringify(expected, null, 2))
      await expect(input.compareDocumentPosition(output) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      await expect(scoped.getByText(index ? "Failed" : "Succeeded")).toBeVisible()
      await userEvent.click(output)
      await userEvent.paste("changed")
      await expect(instance.getValue()).toBe(JSON.stringify(expected, null, 2))
    }
  },
}

export const NarrowToolResults: Story = {
  ...ToolResults,
  decorators: [(Story) => <div className="w-[319px] max-w-full"><Story /></div>],
}

export const ChangedValueType: Story = {
  render: function ChangedValue() {
    const [value, setValue] = React.useState<typeof output | string>(output)
    return (
      <div className="w-[42rem] max-w-full">
        <Button onClick={() => setValue("A plain string")}>
          Select another span
        </Button>
        <StructuredValueViewer label="Output" value={value} />
      </div>
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: "Select another span" })
    )
    await expect(
      canvas.getByRole("combobox", { name: "Output view type" })
    ).toHaveTextContent("Text")
    await expect(canvas.getByText("A plain string")).toBeVisible()
  },
}
