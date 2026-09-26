import type {
  CollectionBeforeChangeHook,
  CollectionConfig,
  GlobalConfig,
} from "payload"
import { editorOnly, isEditor, publishedOrEditor } from "./access"
import { betterAuthStrategy } from "./auth"
import { layoutField, seoField } from "./blocks"
import { populateFAQRelatedPages } from "./hooks/populate-faq-related-pages"

const contentAccess = {
  create: editorOnly,
  read: publishedOrEditor,
  update: editorOnly,
  delete: editorOnly,
  readVersions: editorOnly,
}
const drafts = { drafts: { autosave: { interval: 1500 } }, maxPerDoc: 50 }
const firstPublished: CollectionBeforeChangeHook = ({ data, originalDoc }) => ({
  ...data,
  publishedAt:
    originalDoc?.publishedAt ??
    (data._status === "published" ? new Date().toISOString() : undefined),
})
const slugField = {
  name: "slug",
  type: "text",
  required: true,
  unique: true,
  index: true,
  validate: (value: unknown) =>
    (typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) ||
    "Use lowercase words separated by hyphens.",
} as const

export const Users: CollectionConfig = {
  slug: "cms-users",
  auth: {
    disableLocalStrategy: { enableFields: true, optionalPassword: true },
    removeTokenFromResponses: true,
    strategies: [betterAuthStrategy],
  },
  admin: { useAsTitle: "email", group: "System" },
  access: {
    admin: ({ req }) => isEditor(req.user),
    create: () => false,
    read: editorOnly,
    update: () => false,
    delete: () => false,
  },
  fields: [
    {
      name: "authUserId",
      type: "text",
      required: true,
      unique: true,
      index: true,
      admin: { readOnly: true },
      access: { create: () => false, update: () => false },
    },
    { name: "name", type: "text", required: true },
  ],
}
export const Pages: CollectionConfig = {
  slug: "pages",
  admin: {
    group: "Content",
    useAsTitle: "title",
    defaultColumns: ["title", "slug", "_status", "updatedAt"],
  },
  access: contentAccess,
  versions: drafts,
  fields: [
    { name: "title", type: "text", required: true },
    slugField,
    layoutField,
    seoField,
    { name: "publishedAt", type: "date", admin: { readOnly: true } },
  ],
  hooks: { beforeChange: [firstPublished] },
}
export const FAQs: CollectionConfig = {
  slug: "faqs",
  labels: { singular: "FAQ", plural: "FAQs" },
  admin: {
    group: "Content",
    useAsTitle: "question",
    defaultColumns: ["question", "slug", "_status", "order"],
  },
  access: contentAccess,
  versions: drafts,
  fields: [
    { name: "question", type: "text", required: true },
    slugField,
    {
      name: "shortAnswer",
      type: "textarea",
      admin: {
        description:
          "A concise quick answer for the question page and search results.",
      },
    },
    { name: "answer", type: "richText", required: true },
    {
      name: "relatedPages",
      type: "relationship",
      relationTo: "pages",
      hasMany: true,
      virtual: true,
      admin: {
        readOnly: true,
        description:
          "Automatically includes custom pages that use this question in an FAQ block. Questions sharing a published page or the landing page are linked publicly.",
      },
      hooks: { afterRead: [populateFAQRelatedPages] },
    },
    seoField,
    { name: "order", type: "number", defaultValue: 0 },
    { name: "publishedAt", type: "date", admin: { readOnly: true } },
  ],
  hooks: { beforeChange: [firstPublished] },
}
const globalAccess = {
  read: publishedOrEditor,
  update: editorOnly,
  readVersions: editorOnly,
}
const globalVersions = { drafts: { autosave: { interval: 1500 } }, max: 50 }
export const LandingPage: GlobalConfig = {
  slug: "landing-page",
  label: "Landing page",
  admin: { group: "Content" },
  access: globalAccess,
  versions: globalVersions,
  fields: [
    { name: "title", type: "text", required: true },
    layoutField,
    seoField,
  ],
}
export const FAQPage: GlobalConfig = {
  slug: "faq-page",
  label: "FAQ page",
  admin: { group: "Content" },
  access: globalAccess,
  versions: globalVersions,
  fields: [
    { name: "title", type: "text", required: true },
    { name: "introduction", type: "textarea" },
    seoField,
  ],
}
