import { z } from "zod"

export const metaIdSchema = z
  .string()
  .regex(/^\d{5,30}$/, "Enter a valid Meta ID.")
export const whatsappRecipientSchema = z
  .string()
  .regex(
    /^[1-9]\d{6,19}$/,
    "Use an international phone number with digits only."
  )
export const whatsappModeSchema = z.enum(["cloud", "coexistence"])
export type WhatsAppMode = z.infer<typeof whatsappModeSchema>
export const whatsappTemplateSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9_]{1,512}$/),
    language: z
      .object({ code: z.string().regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/) })
      .strict(),
    components: z.array(z.record(z.string(), z.json())).max(20).optional(),
  })
  .strict()
export type WhatsAppTemplate = z.infer<typeof whatsappTemplateSchema>
export type WhatsAppPhone = {
  id: string
  display_phone_number: string
  verified_name?: string
  is_on_biz_app?: boolean
  platform_type?: string
  quality_rating?: string
}
export type WhatsAppSetup = {
  configured: boolean
  missing: string[]
  appId: string | null
  configId: string | null
  graphVersion: string
  webhookUrl: string | null
}
export type WhatsAppSignup = {
  id: string
  connectionId: string
  mode: WhatsAppMode
  state: string
  expiresAt: string
  phones: WhatsAppPhone[]
  setup: WhatsAppSetup
  connectUrl: string
}
