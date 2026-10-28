import type { WidgetDefinition } from "./contracts"
import { widgetSchemaFromData } from "./widget-code"
import { widgetTemplateTranslations } from "./widget-template-translations"

export type WidgetTemplate = {
  id: string
  category: "Sales" | "Support" | "E-commerce" | "Booking" | "Insights"
  previewImage: string
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
    previewImage: `/widget-templates/${id}.png`,
    definition: {
      name,
      description,
      enabled: false,
      components: [],
      states: { default: data },
      schemaCode: widgetSchemaFromData(data),
      code: `export default function Widget({ data, locale, t }) {
  return (
    <Box padding={20} style={{ border: "1px solid var(--color-border)", borderRadius: 16, background: "var(--color-background)" }}>
      <Col gap={16}>
      <Col gap={6}>
        <h3 style={{ fontSize: 22 }}>{t(data.title)}</h3>
        <Text style={{ color: "var(--color-foreground-muted)" }}>{t(data.description)}</Text>
      </Col>
      <hr style={{ width: "100%", margin: 0, border: 0, borderTop: "1px solid var(--color-border)" }} />
      <Form
        fields={${JSON.stringify(fields, null, 2)}}
        onSubmitAction="submit"
        submitLabel={t(${JSON.stringify(submitLabel)})}
      />
      </Col>
    </Box>
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

const formTemplates: WidgetTemplate[] = [
  formTemplate(
    "contact-form",
    "Sales",
    "Collect leads",
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
    "Book a demo",
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
    previewImage: "/widget-templates/quick-choices.png",
    definition: {
      name: "Quick choices",
      description:
        "Let customers choose between sales, support and order help.",
      enabled: false,
      components: [],
      states: { default: choicesData },
      schemaCode: widgetSchemaFromData(choicesData),
      code: `export default function Widget({ data, locale, t }) {
  return (
    <Card title={t(data.title)} body={t(data.description)}>
      <Col gap={8}>
        <Button onClickAction={{ functionName: "choose_topic", additionalInputs: { topic: "sales" } }}>{t("Talk to sales")}</Button>
        <Button variant="secondary" onClickAction={{ functionName: "choose_topic", additionalInputs: { topic: "support" } }}>{t("Get support")}</Button>
        <Button variant="secondary" onClickAction={{ functionName: "choose_topic", additionalInputs: { topic: "order" } }}>{t("Check an order")}</Button>
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
    previewImage: "/widget-templates/order-summary.png",
    definition: {
      name: "Order summary",
      description:
        "Show an order reference, status and items from your own data.",
      enabled: false,
      components: [],
      states: { default: summaryData },
      schemaCode: widgetSchemaFromData(summaryData),
      code: `export default function Widget({ data, locale, t }) {
  return (
    <Card title={t(data.title)} body={t(data.description)}>
      <Col gap={12}>
        <Text>{t("Order:")} {data.reference}</Text>
        <Text>{t("Status:")} {t(data.status)}</Text>
        <List items={data.items} renderItem={(item) => <Text>{item.quantity} × {t(item.name)}</Text>} />
      </Col>
    </Card>
  )
}
`,
      functions: [],
    },
  },
]

function visualTemplate(
  id: string,
  category: WidgetTemplate["category"],
  name: string,
  description: string,
  data: WidgetDefinition["states"][string],
  code: string,
  functions: WidgetDefinition["functions"] = []
): WidgetTemplate {
  return {
    id,
    category,
    previewImage: `/widget-templates/${id}.png`,
    definition: {
      name,
      description,
      enabled: false,
      components: [],
      states: { default: data },
      schemaCode: widgetSchemaFromData(data),
      code,
      functions,
    },
  }
}

function action(name: string, fields: string[]): WidgetDefinition["functions"] {
  return [
    {
      name,
      actionId: null,
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(
          fields.map((field) => [field, { type: "string" }])
        ),
        required: fields,
      },
      outputSchema: {},
    },
  ]
}

const productImage = "/widget-template-assets/sneaker.webp"
const fitnessImage = "/widget-template-assets/fitness.webp"
const hotelImage = "/widget-template-assets/hotel.webp"

const visualTemplates = [
  visualTemplate(
    "buy-products",
    "E-commerce",
    "Buy products",
    "Show products with images, prices and an add-to-cart action.",
    {
      title: "Select products",
      currency: "USD",
      products: [
        {
          id: "example-trainer",
          name: "Everyday trainer",
          category: "Training shoes",
          price: 64,
          image: productImage,
        },
        {
          id: "example-runner",
          name: "Weekend runner",
          category: "Running shoes",
          price: 79,
          image: productImage,
        },
      ],
    },
    `export default function Widget({ data, locale, t }) {
  const money = (value) => new Intl.NumberFormat(locale, { style: "currency", currency: data.currency }).format(value)
  return <Col gap={14}>
    <Text style={{ color: "var(--color-foreground-muted)" }}>{t(data.title)}</Text>
    <Row gap={12} style={{ flexWrap: "nowrap", overflowX: "auto", alignItems: "stretch", paddingBottom: 4 }}>
      {data.products.map((product) => <Box key={product.id} width={220} style={{ flexShrink: 0, overflow: "hidden", borderRadius: 16, border: "1px solid var(--color-border)", background: "var(--color-background)" }}>
        <Image src={product.image} alt={product.name} style={{ width: "100%", height: 170, display: "block" }} />
        <Col gap={10} padding={14}>
          <Col gap={2}><h3>{product.name}</h3><Text style={{ color: "var(--color-foreground-muted)", fontSize: 12 }}>{t(product.category)}</Text></Col>
          <Text style={{ fontSize: 18, fontWeight: 600 }}>{money(product.price)}</Text>
          <Button onClickAction={{ functionName: "add_to_cart", additionalInputs: { productId: product.id } }} style={{ width: "100%" }}>{t("Add to cart")}</Button>
        </Col>
      </Box>)}
    </Row>
  </Col>
}
`,
    action("add_to_cart", ["productId"])
  ),
  visualTemplate(
    "get-cart",
    "E-commerce",
    "Get cart",
    "Display cart items and totals with a checkout action.",
    {
      currency: "USD",
      cartId: "example-cart",
      items: [
        {
          id: "example-trainer",
          name: "Everyday trainer",
          detail: "Cloud / Size 9",
          quantity: 1,
          price: 64,
          image: productImage,
        },
        {
          id: "example-runner",
          name: "Weekend runner",
          detail: "Cloud / Size 8",
          quantity: 1,
          price: 79,
          image: productImage,
        },
      ],
    },
    `export default function Widget({ data, locale, t }) {
  const money = (value) => new Intl.NumberFormat(locale, { style: "currency", currency: data.currency }).format(value)
  const total = data.items.reduce((sum, item) => sum + item.price * item.quantity, 0)
  const count = data.items.reduce((sum, item) => sum + item.quantity, 0)
  return <Col gap={14}>
    <Text style={{ color: "var(--color-foreground-muted)" }}>{format(t("{{count}} items in cart"), { count })}</Text>
    <Col gap={18} padding={20} style={{ border: "1px solid var(--color-border)", borderRadius: 16, background: "var(--color-background)" }}>
      {data.items.map((item) => <Row key={item.id} gap={12} style={{ flexWrap: "nowrap" }}>
        <Image src={item.image} alt="" style={{ width: 62, height: 62, borderRadius: 10, flexShrink: 0 }} />
        <Col gap={3} style={{ flex: 1 }}><Text style={{ fontWeight: 600 }}>{item.name}</Text><Text style={{ color: "var(--color-foreground-muted)", fontSize: 12 }}>{t(item.detail)} · {t("Qty")} {item.quantity}</Text></Col>
        <Text style={{ fontWeight: 600 }}>{money(item.price * item.quantity)}</Text>
      </Row>)}
      <hr style={{ width: "100%", margin: 0, border: 0, borderTop: "1px solid var(--color-border)" }} />
      <Row style={{ justifyContent: "space-between" }}><Text>{t("Total due")}</Text><Text style={{ fontSize: 20, fontWeight: 650 }}>{money(total)}</Text></Row>
      <Button onClickAction={{ functionName: "checkout", additionalInputs: { cartId: data.cartId } }} style={{ width: "100%" }}>{t("Continue to checkout")}</Button>
    </Col>
  </Col>
}
`,
    action("checkout", ["cartId"])
  ),
  visualTemplate(
    "usage-chart",
    "Insights",
    "Usage chart",
    "Plot a metric across days in a compact, accessible bar chart.",
    {
      title: "Usage",
      metric: "Total credits used",
      values: [640, 340, 520, 670, 220, 610, 730],
      labels: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    },
    `export default function Widget({ data, locale, t }) {
  const total = data.values.reduce((sum, value) => sum + value, 0)
  const max = Math.max(...data.values, 1)
  return <Col gap={14}>
    <Text style={{ color: "var(--color-foreground-muted)" }}>{t(data.title)}</Text>
    <Col gap={18} padding={20} style={{ border: "1px solid var(--color-border)", borderRadius: 16, background: "var(--color-background)" }}>
      <Col gap={4}><Text style={{ color: "var(--color-foreground-muted)" }}>{t(data.metric)}</Text><Text style={{ fontSize: 36, lineHeight: 1.2, fontWeight: 650 }}>{total.toLocaleString(locale)}</Text></Col>
      <svg viewBox="0 0 350 200" role="img" aria-label={t(data.metric) + ": " + data.values.join(", ")} style={{ width: "100%", display: "block" }}>
        {[20, 70, 120, 170].map((y) => <line key={y} x1="0" x2="350" y1={y} y2={y} stroke="var(--color-border)" strokeDasharray="3 4" />)}
        {data.values.map((value, i) => <g key={i}>
          <rect x={i * 50 + 7} y={170 - value / max * 150} width="36" height={value / max * 150} rx="5" fill="var(--color-data-series-primary, var(--color-primary))" />
          <text x={i * 50 + 25} y="194" textAnchor="middle" fontSize="12" fill="var(--color-foreground-muted)">{t(data.labels[i])}</text>
        </g>)}
      </svg>
    </Col>
  </Col>
}
`
  ),
  visualTemplate(
    "gym-class-booking",
    "Booking",
    "Gym class booking",
    "Offer classes with images, levels, schedules and booking actions.",
    {
      title: "Upcoming classes",
      classes: [
        {
          id: "example-flow",
          name: "Morning yoga flow",
          level: "Beginner",
          schedule: "Mon · 7:30 AM",
          coach: "Alex · 45 min",
          image: fitnessImage,
        },
        {
          id: "example-strength",
          name: "Strength foundations",
          level: "All levels",
          schedule: "Wed · 6:00 PM",
          coach: "Sam · 50 min",
          image: fitnessImage,
        },
      ],
    },
    `export default function Widget({ data, locale, t }) {
  return <Col gap={14}>
    <Text style={{ color: "var(--color-foreground-muted)" }}>{t(data.title)}</Text>
    {data.classes.map((item) => <Row key={item.id} gap={14} style={{ flexWrap: "nowrap", alignItems: "stretch", overflow: "hidden", borderRadius: 16, border: "1px solid var(--color-border)", background: "var(--color-background)" }}>
      <Image src={item.image} alt={t("Fitness studio")} style={{ width: "35%", minWidth: 90, objectFit: "cover" }} />
      <Col gap={9} padding={14} style={{ flex: 1, paddingLeft: 0 }}>
        <Col gap={4}><h3>{t(item.name)}</h3><Text style={{ fontSize: 11, width: "fit-content", padding: "2px 8px", borderRadius: 20, background: "var(--color-muted)", color: "var(--color-foreground-muted)" }}>{t(item.level)}</Text></Col>
        <Col gap={1}><Text style={{ fontSize: 13 }}>{t(item.schedule)}</Text><Text style={{ fontSize: 12, color: "var(--color-foreground-muted)" }}>{item.coach}</Text></Col>
        <Button onClickAction={{ functionName: "book_class", additionalInputs: { classId: item.id } }}>{t("Book class")}</Button>
      </Col>
    </Row>)}
  </Col>
}
`,
    action("book_class", ["classId"])
  ),
  visualTemplate(
    "hotel-booking",
    "Booking",
    "Hotel booking",
    "Present a hotel with photos, amenities, pricing and an availability action.",
    {
      id: "example-hotel",
      name: "Hotel Aurora",
      location: "Porto, Portugal",
      price: 220,
      currency: "USD",
      rating: "4.8",
      image: hotelImage,
      amenities: ["Wi-Fi", "Breakfast", "Parking", "Spa"],
    },
    `export default function Widget({ data, locale, t }) {
  const money = new Intl.NumberFormat(locale, { style: "currency", currency: data.currency, maximumFractionDigits: 0 }).format(data.price)
  return <Box style={{ overflow: "hidden", borderRadius: 16, border: "1px solid var(--color-border)", background: "var(--color-background)" }}>
    <Image src={data.image} alt={t("Boutique hotel bedroom")} style={{ display: "block", width: "100%", height: 190 }} />
    <Col gap={16} padding={20}>
      <Row style={{ justifyContent: "space-between", alignItems: "baseline" }}><h3 style={{ fontSize: 22 }}>{data.name}</h3><Text><strong>{money}</strong> {t("/ night")}</Text></Row>
      <Row style={{ justifyContent: "space-between", color: "var(--color-foreground-muted)", fontSize: 12 }}><Text>{data.location}</Text><Text>★ {data.rating} · {t("Example property")}</Text></Row>
      <Col gap={8}><Text style={{ fontWeight: 600 }}>{t("Amenities")}</Text><Row gap={8}>{data.amenities.map((item) => <Box key={item} padding={8} style={{ background: "var(--color-muted)", borderRadius: 8, fontSize: 12 }}>{t(item)}</Box>)}</Row></Col>
      <Button onClickAction={{ functionName: "check_availability", additionalInputs: { hotelId: data.id } }} style={{ width: "100%" }}>{t("Check availability")}</Button>
    </Col>
  </Box>
}
`,
    action("check_availability", ["hotelId"])
  ),
  visualTemplate(
    "fetch-weather",
    "Insights",
    "Fetch weather",
    "Display a weather action's conditions, temperature and forecast.",
    {
      city: "San Francisco",
      temperature: 22,
      unit: "°C",
      condition: "Sunny",
      description: "Clear skies and a light breeze through the afternoon.",
      high: 24,
      low: 16,
    },
    `export default function Widget({ data, locale, t }) {
  return <Col gap={24} padding={28} style={{ textAlign: "center", borderRadius: 20, color: "var(--color-primary-foreground)", background: "linear-gradient(145deg, var(--color-data-series-primary, var(--color-primary)), color-mix(in srgb, var(--color-data-series-primary, var(--color-primary)), var(--color-foreground) 28%))" }}>
    <Row gap={12} style={{ justifyContent: "center", paddingTop: 20 }}>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 1v3m0 16v3M1 12h3m16 0h3M4.2 4.2l2.1 2.1m11.4 11.4 2.1 2.1M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></svg>
      <Text style={{ fontSize: 64, lineHeight: 1.1, fontWeight: 650 }}>{data.temperature}{data.unit}</Text>
    </Row>
    <Col gap={5}><Text style={{ fontSize: 20, fontWeight: 550 }}>{data.city}</Text><Text style={{ opacity: 0.85 }}>{t(data.condition)} · {t("H")} {data.high}° / {t("L")} {data.low}°</Text></Col>
    <Text style={{ fontSize: 13, opacity: 0.85, maxWidth: 290, margin: "0 auto" }}>{t(data.description)}</Text>
    <Button variant="secondary" onClickAction={{ functionName: "refresh_weather", additionalInputs: { city: data.city } }} style={{ alignSelf: "center" }}>{t("Refresh weather")}</Button>
  </Col>
}
`,
    action("refresh_weather", ["city"])
  ),
]

// Lead with the visual starters while retaining the existing form/support templates.
export const widgetTemplates: WidgetTemplate[] = [
  formTemplates[1],
  visualTemplates[0],
  visualTemplates[1],
  visualTemplates[2],
  visualTemplates[3],
  visualTemplates[4],
  formTemplates[0],
  visualTemplates[5],
  ...formTemplates.slice(2),
].map((template) => ({
  ...template,
  definition: {
    ...template.definition,
    translations: widgetTemplateTranslations(template.id),
  },
}))
