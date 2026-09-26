import type { Block, Field } from "payload"
import { safeHref } from "./access"

const href: Field = {
  name: "href",
  type: "text",
  required: true,
  validate: (value: unknown) =>
    safeHref(value) || "Use a relative path, anchor, or HTTP(S)/email link.",
}
export const pageBlocks: Block[] = [
  {
    slug: "hero",
    interfaceName: "HeroBlock",
    fields: [
      { name: "eyebrow", type: "text" },
      { name: "title", type: "text", required: true },
      { name: "description", type: "textarea", required: true },
      {
        name: "actions",
        type: "array",
        maxRows: 2,
        fields: [{ name: "label", type: "text", required: true }, href],
      },
    ],
  },
  {
    slug: "features",
    interfaceName: "FeaturesBlock",
    fields: [
      { name: "title", type: "text", required: true },
      {
        name: "items",
        type: "array",
        minRows: 1,
        maxRows: 12,
        required: true,
        fields: [
          { name: "title", type: "text", required: true },
          { name: "description", type: "textarea", required: true },
        ],
      },
    ],
  },
  {
    slug: "richContent",
    interfaceName: "RichContentBlock",
    fields: [{ name: "content", type: "richText", required: true }],
  },
  {
    slug: "faq",
    interfaceName: "FaqBlock",
    fields: [
      {
        name: "title",
        type: "text",
        required: true,
        defaultValue: "Frequently asked questions",
      },
      {
        name: "items",
        type: "relationship",
        relationTo: "faqs",
        hasMany: true,
        required: true,
        minRows: 1,
      },
    ],
  },
  {
    slug: "callToAction",
    interfaceName: "CallToActionBlock",
    fields: [
      { name: "title", type: "text", required: true },
      { name: "description", type: "textarea" },
      { name: "label", type: "text", required: true },
      href,
    ],
  },
]

export const seoField: Field = {
  name: "seo",
  type: "group",
  fields: [
    { name: "title", type: "text", maxLength: 70 },
    { name: "description", type: "textarea", maxLength: 180 },
    { name: "noIndex", type: "checkbox", defaultValue: false },
  ],
}
export const layoutField: Field = {
  name: "layout",
  type: "blocks",
  blocks: pageBlocks,
  required: true,
  minRows: 1,
}
