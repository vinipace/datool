import nextEnv from "@next/env"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { postgresAdapter } from "@payloadcms/db-postgres"
import { lexicalEditor, LinkFeature } from "@payloadcms/richtext-lexical"
import { buildConfig } from "payload"
import { FAQPage, FAQs, LandingPage, Pages, Users } from "./cms/models"
import { internalDocToHref } from "./cms/rich-text-links"

nextEnv.loadEnvConfig(process.cwd())
const baseDir = path.dirname(fileURLToPath(import.meta.url))
const origin = process.env.BETTER_AUTH_URL || "http://localhost:3000"

export default buildConfig({
  admin: {
    user: "cms-users",
    importMap: { baseDir },
    meta: { titleSuffix: " · Datool CMS" },
    components: {
      beforeLogin: ["./components/cms/admin-login#AdminLogin"],
      logout: { Button: "./components/cms/admin-logout#AdminLogout" },
      beforeNavLinks: ["./cms/system-views#SystemNavigation"],
      views: {
        subscriptions: {
          Component: "./cms/system-views#SubscriptionsView",
          path: "/subscriptions",
          exact: true,
          meta: { title: "Subscriptions" },
        },
        usage: {
          Component: "./cms/system-views#UsageView",
          path: "/usage",
          exact: true,
          meta: { title: "Organization usage" },
        },
        organization: {
          Component: "./cms/system-views#OrganizationView",
          path: "/organizations/:id",
          exact: true,
          meta: { title: "Organization overview" },
        },
      },
    },
    livePreview: {
      collections: ["pages", "faqs"],
      globals: ["landing-page", "faq-page"],
      breakpoints: [
        { name: "mobile", label: "Mobile", width: 390, height: 844 },
        { name: "desktop", label: "Desktop", width: 1440, height: 900 },
      ],
      url: ({ collectionConfig, globalConfig }) =>
        `${origin}/cms-preview?type=${collectionConfig?.slug ?? globalConfig?.slug}`,
    },
  },
  collections: [Users, Pages, FAQs],
  globals: [LandingPage, FAQPage],
  db: postgresAdapter({
    pool: {
      connectionString:
        process.env.PAYLOAD_DATABASE_URL || process.env.DATABASE_URL || "",
      connectionTimeoutMillis: 5000,
    },
    schemaName: "payload",
    push: false,
    migrationDir: path.resolve(baseDir, "payload-migrations"),
  }),
  editor: lexicalEditor({
    features: ({ defaultFeatures }) => [
      ...defaultFeatures.filter((feature) => feature.key !== "link"),
      LinkFeature({ internalDocToHref }),
    ],
  }),
  secret: process.env.PAYLOAD_SECRET || "",
  routes: { admin: "/cms", api: "/cms/api" },
  graphQL: { disable: true },
  cors: [origin],
  csrf: [origin],
  typescript: { outputFile: path.resolve(baseDir, "payload-types.ts") },
})
