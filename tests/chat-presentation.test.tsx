import { expect, test } from "bun:test"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Chat } from "@/components/ui/chat"
import { ChatRichContent } from "@/components/ui/chat-rich-content"
import type { InspectorMessage } from "@/src/lib/tracer/value-messages"

const message: InspectorMessage = {
  id: "answer-1",
  role: "assistant",
  content: "Please provide your **order details**.",
  toolCalls: [],
  metadata: {
    widget: { components: [{ type: "text", text: "Unpinned current widget" }] },
    continuations: [
      {
        type: "form",
        actionId: "lookup-order",
        continuationId: "continuation-1",
        widgetDefinition: {
          name: "Order lookup",
          components: [
            {
              type: "form",
              submitActionId: "lookup-order",
              fields: [
                { name: "order", label: "Order number", required: true },
              ],
            },
          ],
        },
      },
    ],
  },
}

test("operator chat renders pinned widgets and markdown without allowing customer submissions", () => {
  const html = renderToStaticMarkup(
    <Chat
      messages={[message]}
      text=""
      onTextChange={() => {}}
      running={false}
      canSubmit={false}
      composerDisabled
      onSubmit={() => {}}
    />
  )
  expect(html).toContain("<strong>order details</strong>")
  expect(html).toContain("Order number")
  expect(html).not.toContain("Unpinned current widget")
  expect(/<fieldset[^>]*disabled=""/.test(html)).toBe(true)
  expect(/<textarea[^>]*disabled=""/.test(html)).toBe(true)
})

test("interactive widgets do not create nested forms or submit the chat composer", () => {
  const html = renderToStaticMarkup(
    <form>
      <Chat
        messages={[message]}
        text="draft"
        onTextChange={() => {}}
        running={false}
        canSubmit
        onWidgetInteraction={() => {}}
      />
    </form>
  )
  expect(html.match(/<form\b/g)).toHaveLength(1)
  expect(/<fieldset[^>]*disabled/.test(html)).toBe(false)
  expect(/<input[^>]*required=""/.test(html)).toBe(true)
  expect(/<input[^>]*form="[^"]+"/.test(html)).toBe(true)
  expect(/<button[^>]*type="button"[^>]*>Submit<\/button>/.test(html)).toBe(
    true
  )
})

test("feedback selection and pending state are accessible in the shared chat", () => {
  const html = renderToStaticMarkup(
    <Chat
      messages={[message]}
      text=""
      onTextChange={() => {}}
      running={false}
      canSubmit={false}
      feedback={{ value: "negative", disabled: true, onChange: () => {} }}
    />
  )
  const button = html.match(/<button\b[^>]*aria-label="Not helpful"[^>]*>/)?.[0]
  expect(button).toContain('aria-pressed="true"')
  expect(button).toContain('disabled=""')
})

test("completed forms stay submitted when rendering persisted conversation history", () => {
  const html = renderToStaticMarkup(
    <Chat
      messages={[message, { id: "receipt", role: "assistant", content: "Form submitted.", toolCalls: [], metadata: { completedContinuationId: "continuation-1" } }]}
      text="" onTextChange={() => {}} running={false} canSubmit
      onWidgetInteraction={() => {}}
    />
  )
  expect(html).toContain("Submitted")
  expect(html).not.toContain("<fieldset")
})

test("widgets render default data and pinned action inputs as escaped text across cards and lists", () => {
  const widget = {
    components: [
      {
        type: "card",
        title: "Order {{order.id}}",
        body: "{{status}}",
        actionId: null,
      },
      { type: "text", text: "{{description}} {{constructor}}" },
      {
        type: "list",
        itemsPath: "items",
        itemTemplate: "{{name}}: {{price.amount}}",
      },
    ],
    states: {
      default: {
        order: { id: "default" },
        status: "Preparing",
        description: "<script>alert(1)</script>",
        items: [{ name: "Delivery", price: { amount: 15 } }],
      },
    },
  }
  const html = renderToStaticMarkup(
    <ChatRichContent
      message={{
        id: "state-test",
        role: "assistant",
        content: "",
        toolCalls: [],
        metadata: {
          widget: {
            components: [{ type: "text", text: "Current unpinned definition" }],
          },
          continuations: [
            {
              type: "widget",
              actionId: "show-order",
              widgetDefinition: widget,
              input: { order: { id: "A123" } },
            },
          ],
        },
      }}
    />
  )
  expect(html).toContain("Order A123")
  expect(html).toContain("Preparing")
  expect(html).toContain("Delivery: 15")
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
  expect(html).not.toContain("<script>")
  expect(html).not.toContain("Current unpinned definition")
  expect(html).not.toContain("function Object")
})

test("widget preview selects named data states while retaining default values", () => {
  const html = renderToStaticMarkup(
    <ChatRichContent
      message={{
        id: "preview-test",
        role: "assistant",
        content: "",
        toolCalls: [],
        metadata: {
          widgetState: "shipped",
          widget: {
            components: [
              { type: "card", title: "{{title}}", body: "{{status}}" },
            ],
            states: {
              default: { title: "Order status", status: "Preparing" },
              shipped: { status: "On its way" },
            },
          },
        },
      }}
    />
  )
  expect(html).toContain("Order status")
  expect(html).toContain("On its way")
  expect(html).not.toContain("Preparing")
})
