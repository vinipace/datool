import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { StructuredValueView } from "@/components/ui/structured-value-view"

test("LLM formats Markdown while LLM Raw keeps literal text", () => {
  const value = [{ role: "assistant", content: "A **bold** answer" }]
  expect(
    renderToStaticMarkup(<StructuredValueView value={value} view="llm" />)
  ).toContain("<strong>bold</strong>")
  expect(
    renderToStaticMarkup(<StructuredValueView value={value} view="llm-raw" />)
  ).toContain("A **bold** answer")
})

test("LangChain LLM spans default to messages and preserve their raw batch in JSON", () => {
  const value = [[{ role: "user", content: "Batch question" }, { role: "assistant", content: "A **batch** answer" }]]
  const html = renderToStaticMarkup(<StructuredValueView value={value} view="llm" />)
  expect(html).toContain("Batch question")
  expect(html).toContain("<strong>batch</strong>")
  expect(renderToStaticMarkup(<StructuredValueView value={value} view="json" />)).toContain('data-language="json"')
  expect(value).toHaveLength(1)
  expect(value[0]).toHaveLength(2)
})

test("output message views show new messages while structured views retain captured history", () => {
  const inputValue = { messages: [{ role: "user", content: "Input question" }] }
  const value = { messages: [...inputValue.messages, { role: "assistant", content: "New answer" }], todos: ["Completed task"] }
  for (const view of ["llm", "llm-raw"] as const) {
    const html = renderToStaticMarkup(<StructuredValueView value={value} inputValue={inputValue} view={view} />)
    expect(html).toContain("New answer")
    expect(html).not.toContain("Input question")
    expect(renderToStaticMarkup(<StructuredValueView value={value} view={view} />)).toContain("Input question")
  }
  for (const view of ["json", "yaml", "tree", "pretty", "text"] as const) {
    const html = renderToStaticMarkup(<StructuredValueView value={value} inputValue={inputValue} view={view} />)
    expect(html).toContain("Input question")
    expect(html).toContain("New answer")
    expect(html).toContain("Completed task")
  }
  expect(renderToStaticMarkup(<StructuredValueView value={inputValue} inputValue={inputValue} view="llm" />)).toContain("No new output messages.")
})

test("message views retain tools, non-text content and escape untrusted markup", () => {
  const value = [
    {
      role: "assistant",
      content: [
        { type: "text", text: '<script>alert("test")</script> **Done**' },
        {
          type: "tool-call",
          toolName: "estimateRoute",
          args: { from: "Park", to: "Cafe" },
        },
        { type: "image", image: "captured-image-id" },
      ],
    },
  ]
  const html = renderToStaticMarkup(
    <StructuredValueView value={value} view="llm" />
  )
  expect(html).toContain("estimateRoute")
  expect(html).toContain("Cafe")
  expect(html).toContain("Captured content")
  expect(html).toContain("captured-image-id")
  expect(html).not.toContain("<script>")
})

test("mixed dataset rows never disappear under a persisted message view", () => {
  for (const value of [false, 0, null, { answer: "Structured answer" }]) {
    expect(
      renderToStaticMarkup(<StructuredValueView value={value} view="llm" />)
    ).toBe(
      renderToStaticMarkup(<StructuredValueView value={value} view="json" />)
    )
  }
})

test("YAML and tree values use shared syntax tokens", () => {
  const yaml = renderToStaticMarkup(
    <StructuredValueView
      value={{
        count: 2,
        active: false,
        label: "true",
        multiline: "first\nsecond\n",
      }}
      view="yaml"
    />
  )
  expect(yaml).toContain('data-language="yaml"')
  expect(yaml).toContain('class="token key atrule"')
  expect(yaml).toContain('class="token number"')
  expect(yaml).toContain('class="token boolean important"')
  expect(yaml).toContain('class="token scalar string"')
  const tree = renderToStaticMarkup(
    <StructuredValueView value={{ count: 2 }} view="tree" />
  )
  expect(tree).toContain('class="token number"')
})

test("LLM fenced YAML uses the same highlighter", () => {
  const value = [{ role: "assistant", content: "```yaml\nactive: true\n```" }]
  const html = renderToStaticMarkup(
    <StructuredValueView value={value} view="llm" />
  )
  expect(html).toContain('data-language="yaml"')
  expect(html).toContain('class="token boolean important"')
})
