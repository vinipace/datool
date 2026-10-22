import { widgetExampleAssets } from "./widget-example-assets"
import { widgetThemeProperties } from "./widget-frame"

/** Public authoring catalog, also used by the editor's insertion menu. */
export const widgetComponents = [
  {
    name: "Box",
    description:
      "Container with spacing and sizing. Use for custom card surfaces.",
    props: {
      gap: "number (pixels, default 0)",
      padding: "number (pixels, default 0)",
      width: "number | string",
      style: "React.CSSProperties",
      children: "ReactNode",
      "...rest": "HTML div attributes",
    },
    example: "<Box padding={16}><Text>Details</Text></Box>",
  },
  {
    name: "Col",
    description: "Vertical flex layout; accepts Box props.",
    props: {
      gap: "number",
      padding: "number",
      width: "number | string",
      style: "React.CSSProperties",
      children: "ReactNode",
      "...rest": "HTML div attributes",
    },
    example: "<Col gap={12}><Text>Title</Text><Text>Description</Text></Col>",
  },
  {
    name: "Row",
    description:
      "Horizontal, wrapping flex layout. Override flexWrap for a scrollable product row.",
    props: {
      gap: "number",
      padding: "number",
      width: "number | string",
      style: "React.CSSProperties",
      children: "ReactNode",
      "...rest": "HTML div attributes",
    },
    example: "<Row gap={12}><Text>Label</Text><Text>Value</Text></Row>",
  },
  {
    name: "Text",
    description: "Paragraph using the widget's typography.",
    props: {
      children: "ReactNode",
      "...rest": "HTML paragraph attributes, including style",
    },
    example: "<Text>Your message</Text>",
  },
  {
    name: "Card",
    description:
      "Vertical title/body/content group. An optional action adds a Continue button. For a custom surface use Box.",
    props: {
      title: "ReactNode (optional)",
      body: "ReactNode (optional)",
      children: "ReactNode",
      onClickAction: "Action (optional)",
    },
    example:
      '<Card title="Card title" body="Supporting details"><Text>More information</Text></Card>',
  },
  {
    name: "Button",
    description:
      "Styled button. Connect a named Function before dispatching an agent action. This is not a link and has no href prop.",
    props: {
      children: "ReactNode",
      variant: '"primary" | "secondary"',
      onClickAction: "Action (optional)",
      "...rest":
        "HTML button attributes, including disabled, style and onClick",
    },
    example: '<Button onClickAction="choose">Choose</Button>',
    requiresFunction: true,
  },
  {
    name: "Form",
    description:
      "Validated form. Submission dispatches values to a named Function.",
    props: {
      fields:
        'Array<string | { name: string; label?: string; type?: "text" | "email" | "phone" | "number" | "textarea" | "select"; required?: boolean; options?: string[] }>',
      onSubmitAction: "Action (required)",
      submitLabel: 'string (default "Submit")',
    },
    example:
      '<Form fields={[{ name: "email", type: "email", required: true }]} onSubmitAction="submit" submitLabel="Send" />',
    requiresFunction: true,
  },
  {
    name: "List",
    description: "Stacked list with a render callback for each item.",
    props: {
      items: "unknown[] (default [])",
      renderItem: "(item: unknown, index: number) => ReactNode",
    },
    example:
      "<List items={data.items ?? []} renderItem={(item) => <Text>{item.title}</Text>} />",
  },
  {
    name: "Image",
    description:
      "Image restricted to HTTPS or /widget-template-assets/<name>.webp. Supply alt text and dimensions; no credentials are sent via the referrer.",
    props: {
      src: "HTTPS URL or bundled example path",
      alt: 'string (default "")',
      fit: '"contain" | "cover" (default "cover")',
      "...rest": "HTML image attributes, including style and loading",
    },
    example:
      '<Image src="/widget-template-assets/sneaker.webp" alt="Example training shoe" fit="contain" style={{ width: "100%", height: 160 }} />',
  },
] as const

export type WidgetComponentName = (typeof widgetComponents)[number]["name"]

export function widgetComponentCatalog() {
  return {
    components: widgetComponents,
    exampleAssets: Object.values(widgetExampleAssets),
    themeProperties: widgetThemeProperties,
    imports: ["react", "@datool/widgets"],
    schemaImports: ["zod"],
    action:
      "A Function name string, or { functionName: string, additionalInputs?: object }. Bind functions[].actionId to an existing agent action before enabling it.",
    helpers: {
      get: "get(value, dotSeparatedPath)",
      format: "format(templateWithDoubleBraces, data)",
    },
    guidance:
      "Prefer these primitives and an existing template. Semantic HTML is supported where needed, including headings and anchors. Use semantic CSS variables. Do not import application UI modules or assume arbitrary npm imports work in the sandbox.",
  }
}
