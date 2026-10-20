import type { WidgetDefinition } from "./contracts"
import { widgetSchemaFromData } from "./widget-code"

export type WidgetTemplate = {
  id: string
  category: "Sales" | "Support" | "E-commerce"
  definition: WidgetDefinition
}

type FormField = {
  name: string
  label: string
  type?: string
  required?: boolean
  options?: string[]
}

function formTemplate(
  id: string,
  category: WidgetTemplate["category"],
  name: string,
  description: string,
  title: string,
  body: string,
  fields: FormField[],
  submitLabel: string
): WidgetTemplate {
  const data = { title, description: body }
  return {
    id,
    category,
    definition: {
      name,
      description,
      enabled: false,
      components: [],
      states: { default: data },
      schemaCode: widgetSchemaFromData(data),
      code: `export default function Widget({ data }) {
  return (
    <Card title={data.title} body={data.description}>
      <Form
        fields={${JSON.stringify(fields, null, 2)}}
        onSubmitAction="submit"
        submitLabel=${JSON.stringify(submitLabel)}
      />
    </Card>
  )
}
`,
      functions: [
        {
          name: "submit",
          actionId: null,
          inputSchema: {
            type: "object",
            properties: Object.fromEntries(
              fields.map((field) => [field.name, { type: "string" }])
            ),
            required: fields
              .filter((field) => field.required)
              .map((field) => field.name),
          },
          outputSchema: {},
        },
      ],
    },
  }
}

const summaryData = {
  title: "Order summary",
  description:
    "Example data. Replace this with the result of your order action.",
  reference: "EXAMPLE-1001",
  status: "Processing",
  items: [{ name: "Example item", quantity: 1 }],
}

const choicesData = {
  title: "How can we help?",
  description: "Choose a topic to continue.",
}

export const widgetTemplates: WidgetTemplate[] = [
  formTemplate(
    "contact-form",
    "Sales",
    "Contact form",
    "Collect contact details and a message for your team.",
    "Get in touch",
    "Tell us how we can help.",
    [
      { name: "name", label: "Name", required: true },
      { name: "email", label: "Email", type: "email", required: true },
      { name: "message", label: "Message", type: "textarea", required: true },
    ],
    "Send message"
  ),
  formTemplate(
    "demo-request",
    "Sales",
    "Demo request",
    "Capture a prospect's company details and what they want to explore.",
    "Talk to sales",
    "Tell us about your company and what you need.",
    [
      { name: "name", label: "Name", required: true },
      { name: "email", label: "Work email", type: "email", required: true },
      { name: "phone", label: "Phone number", type: "phone" },
      {
        name: "companySize",
        label: "Company size",
        type: "select",
        required: true,
        options: ["1–10", "11–50", "51–200", "201–500", "500+"],
      },
      {
        name: "message",
        label: "How can we help?",
        type: "textarea",
        required: true,
      },
    ],
    "Request a demo"
  ),
  formTemplate(
    "support-request",
    "Support",
    "Support request",
    "Gather a customer's issue and contact email before handing it to your team.",
    "Contact support",
    "Share the details so we can help.",
    [
      { name: "email", label: "Email", type: "email", required: true },
      { name: "subject", label: "Subject", required: true },
      {
        name: "details",
        label: "What happened?",
        type: "textarea",
        required: true,
      },
    ],
    "Send request"
  ),
  {
    id: "quick-choices",
    category: "Support",
    definition: {
      name: "Quick choices",
      description:
        "Let customers choose between sales, support and order help.",
      enabled: false,
      components: [],
      states: { default: choicesData },
      schemaCode: widgetSchemaFromData(choicesData),
      code: `export default function Widget({ data }) {
  return (
    <Card title={data.title} body={data.description}>
      <Col gap={8}>
        <Button onClickAction={{ functionName: "choose_topic", additionalInputs: { topic: "sales" } }}>Talk to sales</Button>
        <Button variant="secondary" onClickAction={{ functionName: "choose_topic", additionalInputs: { topic: "support" } }}>Get support</Button>
        <Button variant="secondary" onClickAction={{ functionName: "choose_topic", additionalInputs: { topic: "order" } }}>Check an order</Button>
      </Col>
    </Card>
  )
}
`,
      functions: [
        {
          name: "choose_topic",
          actionId: null,
          inputSchema: {
            type: "object",
            properties: {
              topic: { type: "string", enum: ["sales", "support", "order"] },
            },
            required: ["topic"],
          },
          outputSchema: {},
        },
      ],
    },
  },
  formTemplate(
    "order-lookup",
    "E-commerce",
    "Order lookup",
    "Ask for an order reference and email to pass to your lookup action.",
    "Find your order",
    "Enter the details used when placing your order.",
    [
      { name: "orderId", label: "Order reference", required: true },
      { name: "email", label: "Email", type: "email", required: true },
    ],
    "Find order"
  ),
  {
    id: "order-summary",
    category: "E-commerce",
    definition: {
      name: "Order summary",
      description:
        "Show an order reference, status and items from your own data.",
      enabled: false,
      components: [],
      states: { default: summaryData },
      schemaCode: widgetSchemaFromData(summaryData),
      code: `export default function Widget({ data }) {
  return (
    <Card title={data.title} body={data.description}>
      <Col gap={12}>
        <Text>Order: {data.reference}</Text>
        <Text>Status: {data.status}</Text>
        <List items={data.items} renderItem={(item) => <Text>{item.quantity} × {item.name}</Text>} />
      </Col>
    </Card>
  )
}
`,
      functions: [],
    },
  },
]
