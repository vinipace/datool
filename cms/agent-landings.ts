import type { CollectionConfig, Field } from "payload"
import { editorOnly, publishedOrEditor } from "./access"
import { seoField } from "./blocks"

const text = (name: string, required = true, description?: string): Field => ({
  name,
  type: "text",
  required,
  ...(description && { admin: { description } }),
})
const textarea = (name: string, required = true): Field => ({
  name,
  type: "textarea",
  required,
})

export const AgentLandings: CollectionConfig = {
  slug: "agent-landings",
  dbName: "agent_lp",
  labels: { singular: "Agent landing", plural: "Agent landings" },
  admin: {
    group: "Content",
    useAsTitle: "title",
    defaultColumns: ["title", "slug", "_status", "updatedAt"],
    description:
      "One landing page per AI agent, published at /agents/<slug>. Each tells one customer's story.",
  },
  access: {
    create: editorOnly,
    read: publishedOrEditor,
    update: editorOnly,
    delete: editorOnly,
    readVersions: editorOnly,
  },
  versions: { drafts: { autosave: { interval: 1500 } }, maxPerDoc: 50 },
  fields: [
    { name: "title", type: "text", required: true },
    {
      name: "slug",
      type: "text",
      required: true,
      unique: true,
      index: true,
      admin: { description: "The page is published at /agents/<slug>." },
      validate: (value: unknown) =>
        (typeof value === "string" &&
          /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) ||
        "Use lowercase words separated by hyphens.",
    },
    {
      name: "channel",
      type: "select",
      required: true,
      defaultValue: "web",
      admin: { description: "Where the story's conversation happens." },
      options: [
        { label: "Website chat", value: "web" },
        { label: "WhatsApp", value: "whatsapp" },
        { label: "In-product", value: "app" },
      ],
    },
    {
      name: "whatsapp",
      type: "group",
      admin: {
        description: "Every demo request opens this WhatsApp conversation.",
      },
      fields: [
        {
          name: "number",
          type: "text",
          required: true,
          validate: (value: unknown) =>
            (typeof value === "string" && /^\d{10,15}$/.test(value)) ||
            "Use the international number with digits only, e.g. 551151995330.",
        },
        textarea("message"),
      ],
    },
    {
      name: "hero",
      type: "group",
      fields: [
        text("title"),
        text("accent", false, "Shown on its own line in the accent style."),
        textarea("description"),
        text("primaryLabel"),
        text(
          "scrollLabel",
          false,
          "Invites visitors to scroll into the story."
        ),
      ],
    },
    {
      name: "story",
      type: "group",
      admin: {
        description:
          "One customer's conversation, revealed chapter by chapter as visitors scroll.",
      },
      fields: [
        text("contact", true, "Customer name, shown in WhatsApp."),
        text(
          "assistant",
          true,
          "Assistant name, shown in the website and in-product widgets."
        ),
        text(
          "site",
          true,
          "Address bar text for the website and in-product frames."
        ),
        {
          name: "chapters",
          type: "array",
          minRows: 2,
          maxRows: 10,
          required: true,
          fields: [
            text("time", true, "Shown above the chapter title, e.g. Thursday."),
            text("title"),
            text("text"),
            {
              name: "messages",
              type: "array",
              minRows: 1,
              maxRows: 6,
              required: true,
              fields: [
                {
                  name: "from",
                  type: "select",
                  required: true,
                  defaultValue: "customer",
                  options: [
                    { label: "Customer", value: "customer" },
                    { label: "AI agent", value: "agent" },
                    { label: "Human agent", value: "human" },
                    { label: "Event", value: "event" },
                  ],
                },
                {
                  name: "text",
                  type: "textarea",
                  required: true,
                  admin: {
                    description:
                      "Links such as store.com/checkout are styled as links. Events show as a notification beside the device.",
                  },
                },
                {
                  name: "showProducts",
                  type: "checkbox",
                  defaultValue: false,
                  admin: { description: "Attach the products below." },
                },
                {
                  name: "highlight",
                  type: "checkbox",
                  defaultValue: false,
                  admin: {
                    description:
                      "In-product only: spotlights the app's main button.",
                  },
                },
              ],
            },
          ],
        },
        {
          name: "products",
          type: "array",
          maxRows: 3,
          fields: [
            text("name"),
            text("price"),
            {
              name: "tone",
              type: "select",
              required: true,
              defaultValue: "leaf",
              options: ["leaf", "lilac", "peach"],
            },
          ],
        },
      ],
    },
    {
      name: "features",
      type: "group",
      admin: { description: "Bento grid shown after the story." },
      fields: [
        text("title"),
        text("accent", false, "Shown after the title in the accent style."),
        {
          name: "items",
          type: "array",
          minRows: 1,
          maxRows: 12,
          required: true,
          fields: [
            text("title"),
            text("text"),
            {
              name: "visual",
              type: "select",
              required: true,
              options: [
                { label: "WhatsApp chat", value: "whatsapp" },
                { label: "Website widget", value: "website" },
                { label: "In-product panel", value: "inproduct" },
                { label: "Spotlight", value: "spotlight" },
                { label: "Product cards", value: "catalog" },
                { label: "Handoff", value: "handoff" },
                { label: "Help article", value: "knowledge" },
                { label: "System actions", value: "actions" },
                { label: "In-chat widget", value: "widgets" },
                { label: "Lead capture", value: "leads" },
                { label: "Campaign message", value: "campaigns" },
                { label: "Guardrail", value: "guardrails" },
                { label: "Test results", value: "analytics" },
              ],
            },
            {
              name: "size",
              type: "select",
              required: true,
              defaultValue: "regular",
              options: [
                { label: "Regular (1×1)", value: "regular" },
                { label: "Wide (2×1)", value: "wide" },
                { label: "Large (2×2)", value: "large" },
              ],
            },
          ],
        },
      ],
    },
    {
      name: "faq",
      type: "group",
      label: "FAQ",
      fields: [
        text("title"),
        // Questions live in the FAQs collection so each one has its own page.
        {
          name: "items",
          type: "relationship",
          relationTo: "faqs",
          hasMany: true,
          minRows: 1,
          maxRows: 10,
          required: true,
        },
      ],
    },
    {
      name: "cta",
      type: "group",
      fields: [text("title"), textarea("description", false), text("label")],
    },
    seoField,
  ],
}
