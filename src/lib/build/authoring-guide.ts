import { z } from "zod"
import { agentSandboxSchema } from "./sandbox"
import { sdkChatInputSchema } from "./react-sdk"
import { scheduledTaskInputSchema } from "./schedules"
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
  "sandbox",
  "integration",
  "react-sdk",
  "scheduled-task",
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
    sandbox: agentSandboxSchema,
    integration: actionDefinitionSchema,
    "react-sdk": sdkChatInputSchema,
    "scheduled-task": scheduledTaskInputSchema,
  }
  const examples = {
    sandbox: {
      enabled: true,
      provider: "datool",
      environment: "node",
      networkAccess: false,
      drives: [],
    },
    integration: {
      id: "workspace_lookup",
      name: "Look up workspace",
      type: "integration",
      enabled: false,
      connectionId: "11111111-1111-4111-8111-111111111111",
      toolSlug: "DISCOVERED_TOOL_SLUG",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    "react-sdk": {
      connectionId: "11111111-1111-4111-8111-111111111111",
      userId: "authenticated-user",
      drive: "drive_acme",
      workspaceName: "Acme Studio",
      request: { action: "session", threadId: "default" },
    },
    "scheduled-task": {
      agentId: "discovered-agent-id",
      name: "Weekday briefing",
      prompt: "Read /workspace/context/company.md and summarize next steps.",
      schedule: { kind: "cron", expression: "0 9 * * 1-5" },
      timezone: "America/Sao_Paulo",
      channel: "web",
      enabled: false,
    },
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
    sandbox: [
      "Put this configuration under configuration.sandbox in build_update_agent, preserving unrelated settings and the current expectedRevision. Provider setup is separate; choose an available provider and keep each drive on the provider that owns it.",
      "build_create_drive creates shared persistent storage. Mount returned drive IDs at no more than four unique, non-overlapping /workspace paths. Only mounted contents persist after a turn. Eve exposes bash, read_file, write_file, edit_file, glob and grep when allowed by the agent's routing and approval settings.",
      "build_list_drives accepts agentId and returns shared drives plus this agent's SDK-managed drives, even before any chat exists. Follow nextCursor using after. sdkContext supplies agentId, connectionId, workspace and workspaceName for display; it never grants access.",
      "SDK sessions mount only their own application drive at /workspace and exclude static shared agent drives. Do not add SDK drives to configuration.sandbox.drives. Manage their files through build_sdk_files or the server SDK. Workspace names are display labels, not authentication.",
    ],
    integration: [
      "In the UI, manage a connection on its own Integrations page. Tools appear first with search, enabled/disabled filters and infinite scrolling; connection settings are separate. Actions is for custom tools. Integration tool definitions still use the action API for revisions and execution.",
      "Discover build_list_app_connections and build_list_app_tools. For custom Streamable HTTP servers use build_save_mcp_connection with a public HTTPS URL, or build_start_mcp_oauth and the returned sign-in URL. OAuth needs a signed-in project member; do not guess or fabricate credentials. Omit saved URL/token on updates to preserve them.",
      "build_enable_mcp_tools imports missing tools and applies the agent catalog; it preserves existing enabled/settings values. Supplying agentId during MCP connection setup can also import and publish tools. This is an applying mutation, not just discovery.",
      "To toggle one tool, find its existing build_list_actions definition by connectionId/toolSlug, preserve its ID and settings, and use build_save_action with its current revision and definition.enabled. For a new tool, use the discovered tool schema and IDs. Apply the intended agent revision with build_update_agent. Never create duplicate definitions just to toggle a tool.",
      "Disconnecting a connection revokes it for all agent revisions. Disabling a single tool affects this agent's applied catalog. Verify the requested scope before choosing either action.",
    ],
    "react-sdk": [
      "Configure an api channel through build_create_channel and build_update_channel_status, or Channels > React SDK. The applied agent must allow api; enable Sandbox when using files. Read the returned connection ID, never guess it.",
      "Use createDatoolHandler from @datool/react/server in your application's authenticated POST route, including Next.js app/api/datool/[[...datool]]/route.ts. Resolve userId and drive from server-side auth on every request. Return workspaceName only as a friendly display label. Keep API keys on the server; render DatoolChat from @datool/react with an endpoint on your application's origin and import @datool/react/styles.css.",
      "Use createDatoolClient from @datool/sdk/agents with the same connectionId, userId, drive and threadId for files, messages and tasks. If the authenticated workspace changes, recreate the scoped client and reset the chat React key. Load the matching saved context before opening chat; a file is available for the agent to read, not automatically injected into its instructions.",
      "This example is a build_sdk_chat session input. Reuse the returned conversationId for messages/send and build_sdk_tasks. Send requires a stable requestId UUID; pending replies require polling. File requests use build_sdk_files, drive-relative paths and base64 content, with a 256 KiB file limit and 500-entry directory limit. The SDK handles encoding.",
      "Use build_sdk_tasks for per-user proactive work. Task creation saves the original user scope, connection, drive and conversation; all later runs verify that binding and reject missing/changed context. They read current file contents from the saved drive. A workspace switch never retargets an existing task. Pause/delete tasks when application access is revoked.",
      "Discover scopes before execution: chat requires build:run; files require build:write and build:run; SDK tasks require build:read, build:write and build:run. The project's server credential may address app users; it must never be exposed to those users. Confirm installed packages and deployed support separately; repository source does not prove an npm release.",
    ],
    "scheduled-task": [
      "This example is for build_create_scheduled_task, a shared agent task. It runs with published agent settings and starts a new conversation each run. For a user/workspace-bound task use build_sdk_tasks action=create instead; never imitate binding by setting channel=api or supplying sdkContext.",
      "Choose an IANA timezone and a five-field cron expression, or schedule:{kind:'once',at:<future ISO timestamp with offset>}. Start disabled if preparing a draft. Creation and run-now require a stable idempotencyKey; edits/deletion require expectedRevision from the current task.",
      "build_list_scheduled_tasks accepts agentId, search, cursor and limit. It returns workspace/drive/conversation in sdkContext without the private scope key. Search includes workspace names. The Scheduled tasks UI shows the same workspace and original conversation.",
      "SDK tasks and queued runs retain their original binding through edits, pauses and manual runs. Missing or changed bindings fail closed. Their channel cannot be changed away from api. Shared tasks use the agent's static drives; SDK tasks use only their saved application drive.",
      "Use build_run_scheduled_task for a run now; inspect build_list_scheduled_task_runs until a terminal state. Queued/completed execution is separate from useful output. Pausing stops future scheduled runs; started work may finish. Deleting cancels unstarted runs and retains existing conversations/history.",
    ],
    agent: [
      "Use build_create_agent or build_update_agent; put the example under configuration, not definition. A create establishes an initial applied revision. Use apply:false for subsequent draft edits and apply:true only when the reviewed changes should go live.",
      "Read build_get_agent and preserve unrelated configuration. Use its current revision as expectedRevision on updates; use build_list_agent_revisions and build_restore_agent_revision for history/rollback.",
      "guardrails.jevCheckEnabled controls the pre-generation Jev scope router and defaults to true. channelOverrides[channel].jevCheckEnabled can opt out a channel; the agent-wide switch must also be enabled. Turning it off skips Jev calls and their usage while retaining normal generation and other guardrails. Jev selects answer, redirect or clarify; redirect/clarify disable tools. This is routing, not an extra response judge.",
      "Configure instructions, provider/model, channels, guardrails, sandbox and web access using the schema. sandbox.enabled exposes Eve's bash, read_file, write_file, edit_file, glob and grep tools except when human approval is required or external actions are mocked in simulations. Commands share one environment during the turn; only mounted drives persist afterwards. Create/list project drives with build_create_drive/build_list_drives and mount at most four non-overlapping paths under /workspace. Drives belong to their provider; never switch providers as a fallback for an existing drive. web.fetchEnabled enables public URL reading; web.searchEnabled enables provider-managed search using project model credentials. Both are off by default and unavailable on restricted Jev routes or in simulations. Provider credentials and external app authorization are separate setup steps; never embed secrets in instructions.",
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
