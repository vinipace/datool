import { z } from "zod"
import { widgetComponentCatalog } from "./widget-components"
import {
  actionDefinitionSchema,
  agentConfigurationSchema,
  procedureDefinitionSchema,
  widgetDefinitionSchema,
} from "./contracts"
import { skillFromTemplate, skillTemplates } from "./skill-templates"
import { widgetTemplates } from "./widget-templates"

export const authoringTopicSchema = z.enum([
  "agent",
  "action",
  "skill",
  "widget",
])

/** Public sandbox component contract; JSX props include functions and React nodes,
 * so these signatures are documentation rather than JSON instance schemas. */
export function widgetComponentsGuide() {
  const catalog = widgetComponentCatalog()
  const notes = {
    imports: { jsx: ["react", "@datool/widgets"], schema: ["zod"] },
    entrypoint:
      "export default function Widget({ data, locale, t }) { return <Text>{t(data.title)}</Text> }",
    props: {
      data: "The selected state after validation and defaults from schemaCode.",
      locale: "The chat's selected visitor locale, defaulting to en.",
      t: "(key: string) => string. Dictionary lookup with language and source-text fallback; no automatic translation, interpolation or pluralization.",
    },
    actionBinding:
      "A function name string, or { functionName, additionalInputs }. The name must exist in definition.functions and be connected to an actionId before live interaction.",
    components: [
      {
        name: "Box",
        props:
          "HTML div props; gap?: number = 0; padding?: number = 0; width?: number | string; style?: CSSProperties; children?: ReactNode",
      },
      { name: "Col", props: "Box props; vertical flex layout." },
      {
        name: "Row",
        props:
          "Box props; wrapping horizontal flex layout, centered alignment.",
      },
      { name: "Text", props: "HTML paragraph props; children?: ReactNode." },
      {
        name: "Card",
        props:
          "title?: ReactNode; body?: ReactNode; children?: ReactNode; onClickAction?: ActionBinding. Translate title/body yourself. An onClickAction adds the runtime's Continue button; use an explicit translated Button child for localized copy.",
      },
      {
        name: "Button",
        props:
          'HTML button props; variant?: "primary" | "secondary"; onClickAction?: ActionBinding; children?: ReactNode. Always type=button; disabled when interaction is unavailable.',
      },
      {
        name: "Form",
        props:
          'fields: Array<string | { name: string; label?: string; type?: "text" | "email" | "phone" | "number" | "textarea" | "select"; required?: boolean; options?: string[] }>; onSubmitAction: ActionBinding; submitLabel?: string = "Submit". Labels/options use translations automatically; pass t(...) for submitLabel. Values are strings keyed by canonical field names. JSX Form does not implement native form-action checkbox/lead-capture semantics.',
      },
      {
        name: "List",
        props:
          "items?: unknown[] = []; renderItem: (item, index) => ReactNode.",
      },
      {
        name: "Image",
        props:
          'HTML image props; src: HTTPS URL or /widget-template-assets/<name>.webp; alt?: string = ""; fit?: "cover" | "contain" = "cover". Invalid sources render nothing. Translate descriptive alt text.',
      },
    ],
    helpers: {
      get: "get(value, dottedPath): read a nested property.",
      format:
        'format(t("Hello {{name}}"), { name }): interpolate a translated phrase.',
    },
    themeProperties: [
      "--color-background",
      "--color-foreground",
      "--color-muted",
      "--color-foreground-muted",
      "--color-border",
      "--color-primary",
      "--color-primary-foreground",
      "--color-ring",
      "--color-destructive",
      "--color-data-series-primary",
    ],
    assets: [
      "/widget-template-assets/sneaker.webp",
      "/widget-template-assets/fitness.webp",
      "/widget-template-assets/hotel.webp",
    ],
    isolation:
      "Code and Zod schemas run in an opaque iframe. No arbitrary imports, parent access or network fetches. Use connected named Functions for external actions. Server save checks syntax; it does not prove browser rendering or successful action execution.",
  }
  return {
    ...catalog,
    entrypoint: notes.entrypoint,
    props: notes.props,
    isolation: notes.isolation,
    components: catalog.components.map((component) => ({
      ...component,
      authoringNotes: notes.components.find(
        (note) => note.name === component.name
      )?.props,
    })),
  }
}

export function buildAuthoringGuide(
  topic: z.infer<typeof authoringTopicSchema>
) {
  const schemas = {
    agent: agentConfigurationSchema,
    action: actionDefinitionSchema,
    skill: procedureDefinitionSchema,
    widget: widgetDefinitionSchema,
  }
  const examples = {
    agent: {
      instructions:
        "Answer from approved knowledge. Follow the visitor's language. Confirm actions only after success.",
      channelAllowlist: ["web"],
    },
    action: {
      id: "request_demo",
      name: "Request a demo",
      type: "form",
      enabled: false,
      captureLead: true,
      submitLabel: "Request demo",
      fields: [
        { name: "email", label: "Work email", type: "email", required: true },
      ],
      translations: {
        "pt-BR": {
          "Request demo": "Solicitar demonstração",
          "Work email": "E-mail profissional",
        },
        es: {
          "Request demo": "Solicitar una demo",
          "Work email": "Correo de trabajo",
        },
      },
    },
    skill: skillFromTemplate(
      skillTemplates.find((item) => item.id === "lead-meeting")!
    ),
    widget: structuredClone(
      widgetTemplates.find((item) => item.id === "demo-request")!.definition
    ),
  }
  const guidance = {
    agent: [
      "Use build_create_agent or build_update_agent; put the example under configuration, not definition. A create establishes an initial applied revision. Use apply:false for subsequent draft edits and apply:true only when the reviewed changes should go live.",
      "Read build_get_agent and preserve unrelated configuration. Use its current revision as expectedRevision on updates; use build_list_agent_revisions and build_restore_agent_revision for history/rollback.",
      "Configure instructions, provider/model, channels and guardrails using the schema. Provider credentials and external app authorization are separate setup steps; never embed secrets in instructions.",
    ],
    action: [
      "Use build_save_action with agentId and definition. Inspect connected app tools with build_list_app_tools before defining integration actions. Bind verified connection/tool IDs, never guessed ones.",
      "Choose the matching discriminated type: integration, shopify, http, client, widget, form or handoff. Retain canonical input names/enums. HTTP header values are sensitive and reads redact them; follow the save operation's preservation behavior.",
      "Native form actions support translations, checkbox fields and captureLead. A successful standalone native form result lets the agent acknowledge naturally; a captured request is not a confirmed meeting. Custom JSX Form instead invokes its bound function.",
    ],
    skill: [
      "Skills are named procedures in the API. Discover build_list_skill_templates/build_get_skill_template; save the returned definition with build_save_procedure.",
      "Use nonempty instructions OR structured steps. Instructions cannot be combined with steps or branches. At least instructions or one step is required; these semantic refinements are enforced on save, beyond the JSON Schema.",
      "Use verified action references and available trigger types. Keep new drafts disabled until their actions are connected. Follow the visitor's explicit language preference; country is only an initial hint. Do not translate action IDs or submitted enums.",
    ],
    widget: [
      "Discover build_list_widget_templates/build_get_widget_template and build_get_widget_components first. Templates contain example data and unconnected functions; keep them disabled until connected. Save a full definition with build_save_widget.",
      "Export a default React component from code and a default Zod schema from schemaCode. Provide representative states.default. At least code or legacy components is required; JSON Schema does not express every save-time refinement.",
      "Translate visible JSX with t(key), and set translations[locale][key]. Built-in Form translates labels/options; use submitLabel={t(...)}. Preserve field names, option values, IDs, currencies and amounts. Use Intl.NumberFormat(locale, ...) for display formatting. Do not concatenate bilingual labels.",
      "Use documented theme tokens and components. Preview light/dark, narrow/wide screens, missing data, each locale and fallback. Successful save validates syntax, not layout, action delivery or production deployment.",
    ],
  }
  return {
    topic,
    schemaDialect: "https://json-schema.org/draft/2020-12/schema",
    schema: z.toJSONSchema(schemas[topic], {
      io: "input",
      target: "draft-2020-12",
    }),
    example: schemas[topic].parse(examples[topic]),
    guidance: guidance[topic],
    workflow: [
      "Use build_describe_operations for the deployed operation input schemas, scopes and retry/revision policies. This guide describes the current server; it does not grant permissions.",
      "Read existing resources before editing and preserve unrelated fields. Save with a stable idempotencyKey and the current expectedRevision when updating; refetch after conflicts.",
      "Read back the saved definition. Test with synthetic inputs and approved mocks before applying the agent revision. Saving a definition, applying the agent and verifying live behavior are separate steps.",
    ],
  }
}
