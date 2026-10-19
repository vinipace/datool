import { z } from "zod"
import { agentAppearanceSchema } from "./contracts"
import { safeHttpUrlSchema } from "./urls"

export const bubbleLanguageSchema = z.enum(["en", "pt-BR", "es"])
export type BubbleLanguage = z.infer<typeof bubbleLanguageSchema>
const localizedContentSchema = z.object({
  welcomeMessage: z.string().max(4_000).optional(),
  inputPlaceholder: z.string().max(300).optional(),
  suggestedReplies: z.array(z.string().min(1).max(300)).max(12).optional(),
  launcherLabel: z.string().max(40).optional(),
})

export const helpPageSettingsSchema = z.object({
  pageTitle: z.string().max(160).default("Help center"),
  description: z.string().max(600).default(""),
  faviconUrl: safeHttpUrlSchema.max(2_048).nullable().default(null),
  logoUrl: safeHttpUrlSchema.max(2_048).nullable().default(null),
  heroImageUrl: safeHttpUrlSchema.max(2_048).nullable().default(null),
  showSidebar: z.boolean().default(true),
  allowThemeSwitch: z.boolean().default(false),
  fieldGlow: z.boolean().default(true),
  links: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        label: z.string().max(120).default(""),
        url: safeHttpUrlSchema.or(z.literal("")).default(""),
        description: z.string().max(300).default(""),
        placement: z.enum(["sidebar", "primary", "card"]).default("card"),
        enabled: z.boolean().optional(),
      })
    )
    .max(12)
    .default([]),
})
export type HelpPageSettings = z.infer<typeof helpPageSettingsSchema>

/** Customer-selected appearance values, shared by the editor and public embed. */
export const chatBubbleSettingsSchema = agentAppearanceSchema.extend({
  layout: z.enum(["bubble", "help_page"]).default("bubble"),
  helpPage: helpPageSettingsSchema.default(() =>
    helpPageSettingsSchema.parse({})
  ),
  theme: z.enum(["light", "dark"]).default("light"),
  accentHeader: z.boolean().default(false),
  accentSend: z.boolean().default(true),
  radius: z.enum(["square", "small", "medium", "large"]).default("large"),
  fontFamily: z.enum(["system", "inter", "serif"]).default("system"),
  fontSize: z.union([z.literal(14), z.literal(16), z.literal(18)]).default(16),
  position: z.enum(["left", "right"]).default("right"),
  offsetX: z.number().int().min(0).max(120).default(20),
  offsetY: z.number().int().min(0).max(120).default(20),
  launcherLabel: z.string().max(40).default(""),
  launcherIcon: z
    .enum(["chat", "sparkles", "headset", "custom"])
    .default("chat"),
  launcherIconUrl: safeHttpUrlSchema.max(2_048).nullable().default(null),
  launcherColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .default(null),
  localization: z
    .object({
      source: z.enum(["browser", "fixed"]).default("browser"),
      defaultLanguage: bubbleLanguageSchema.default("en"),
      languages: z.array(bubbleLanguageSchema).min(1).max(3).default(["en"]),
      translations: z
        .object({
          en: localizedContentSchema.optional(),
          "pt-BR": localizedContentSchema.optional(),
          es: localizedContentSchema.optional(),
        })
        .default({}),
    })
    .default({
      source: "browser",
      defaultLanguage: "en",
      languages: ["en"],
      translations: {},
    }),
  showBranding: z.boolean().default(true),
  showFeedback: z.boolean().default(true),
})
// Defaults belong to the final resolved appearance, not to an override. Zod's
// partial() still applies inner defaults, which would erase inherited content.
type BubbleShape = typeof chatBubbleSettingsSchema.shape
export const chatBubbleOverridesSchema = z.object(
  Object.fromEntries(
    Object.entries(chatBubbleSettingsSchema.shape).map(([key, field]) => [
      key,
      field.removeDefault().optional(),
    ])
  ) as {
    [K in keyof BubbleShape]: z.ZodOptional<BubbleShape[K]["def"]["innerType"]>
  }
)
export type ChatBubbleSettings = z.infer<typeof chatBubbleSettingsSchema>
export type ChatBubbleOverrides = z.infer<typeof chatBubbleOverridesSchema>

export function resolveChatBubbleSettings(
  appearance: unknown,
  overrides: unknown = {}
) {
  return chatBubbleSettingsSchema.parse({
    ...agentAppearanceSchema.parse(appearance ?? {}),
    ...chatBubbleOverridesSchema.parse(overrides ?? {}),
  })
}
