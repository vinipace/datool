import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import type { InspectorMessage } from "@/src/lib/tracer/value-messages"
import { MessageTranscript } from "./message-transcript"

const submitted = fn()
const form: InspectorMessage = {
  id: "demo-form",
  role: "assistant",
  content: "Preencha seus dados para solicitar uma demonstração.",
  toolCalls: [],
  metadata: {
    continuations: [
      {
        type: "form",
        actionId: "request-demo",
        continuationId: "demo-request",
        title: "Request a demo",
        submitLabel: "Request demo",
        fields: [
          { name: "name", label: "Name", type: "text", required: true },
          {
            name: "email",
            label: "Email for this request",
            type: "email",
            required: true,
          },
          {
            name: "interest",
            label: "Interest",
            type: "select",
            options: ["Sales", "Support"],
          },
        ],
        translations: {
          "pt-BR": {
            "Request a demo": "Solicitar uma demonstração",
            "Request demo": "Solicitar demonstração",
            Name: "Nome",
            "Email for this request": "E-mail para este pedido",
            Interest: "Interesse",
            Sales: "Vendas",
            Support: "Atendimento",
          },
        },
      },
    ],
  },
}

function FormConversation() {
  const [messages, setMessages] = useState([form])
  return (
    <div
      className="datool-chat-surface mx-auto max-w-lg bg-background p-5 text-foreground"
      data-theme="light"
    >
      <MessageTranscript
        messages={messages}
        variant="customer"
        locale="pt-BR"
        onWidgetInteraction={(_, interaction, label) => {
          submitted(interaction)
          // Public API fixtures: internal event, durable receipt, then model reply.
          setMessages([
            form,
            {
              id: "event",
              role: "user",
              content: label,
              toolCalls: [],
              metadata: { customerInteraction: true },
            },
            {
              id: "receipt",
              role: "assistant",
              content: "private form result",
              toolCalls: [],
              metadata: {
                internalFormReceipt: true,
                completedContinuationId: "demo-request",
              },
            },
            {
              id: "reply",
              role: "assistant",
              content:
                "Obrigado, Ana! Seu pedido foi registrado. A equipe pode entrar em contato pelo e-mail informado para combinar a demonstração.",
              toolCalls: [],
            },
          ])
        }}
      />
    </div>
  )
}

const meta = {
  title: "Build/LocalizedWidgets",
  component: MessageTranscript,
  args: { messages: [] },
  beforeEach: () => {
    submitted.mockClear()
  },
} satisfies Meta<typeof MessageTranscript>
export default meta
type Story = StoryObj<typeof meta>

export const FormSubmission: Story = {
  render: () => <FormConversation />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByRole("textbox", { name: "Nome *" }), "Ana")
    await userEvent.type(
      canvas.getByRole("textbox", { name: "E-mail para este pedido *" }),
      "synthetic@example.test"
    )
    await userEvent.selectOptions(
      canvas.getByRole("combobox", { name: "Interesse" }),
      "Sales"
    )
    await expect(canvas.getByRole("option", { name: "Vendas" })).toHaveValue(
      "Sales"
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Solicitar demonstração" })
    )
    await expect(submitted).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "request-demo",
        continuationId: "demo-request",
        input: {
          name: "Ana",
          email: "synthetic@example.test",
          interest: "Sales",
        },
      })
    )
    await expect(canvas.getByText(/^Obrigado, Ana!/)).toBeVisible()
    await expect(
      canvas.queryByText("Solicitar demonstração")
    ).not.toBeInTheDocument()
    await expect(canvas.queryByText("Submitted")).not.toBeInTheDocument()
    await expect(canvas.queryByText("Form submitted.")).not.toBeInTheDocument()
    await expect(
      canvas.queryByText("private form result")
    ).not.toBeInTheDocument()
    await expect(canvas.queryByRole("textbox")).not.toBeInTheDocument()
    await waitFor(() =>
      expect(
        getComputedStyle(
          canvas.getByText(/^Obrigado, Ana!/).closest("article")!
        ).opacity
      ).toBe("1")
    )
  },
}

export const TranslatedCodeWidget: Story = {
  args: {
    locale: "pt-BR",
    variant: "customer",
    messages: [
      {
        id: "code-example",
        role: "assistant",
        content: "",
        toolCalls: [],
        metadata: {
          widget: {
            name: "Your next step",
            translations: {
              "pt-BR": {
                "Your next step": "Seu próximo passo",
                "Explore Datool": "Conheça a Datool",
                "See how it works": "Veja como funciona",
              },
            },
            code: 'export default function Widget({ locale, t }) { return <Card title={t("Explore Datool")} body={t("See how it works")} /> }',
            states: {},
            functions: [],
          },
        },
      },
    ],
  },
}
