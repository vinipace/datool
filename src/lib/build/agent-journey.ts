import { z } from "zod"
import { buildChannelSchema } from "./contracts"
import type { JsonObject } from "@/src/lib/tracer/contracts"

export const newJourneyInput = (): JsonObject => ({
  message: "",
  channel: "web",
  journey: {
    name: "Customer journey",
    required: true,
    width: 390,
    locale: "en",
    steps: [{ type: "expect_text", text: "" }],
    actionMocks: [],
  },
})

const name = z.string().trim().min(1).max(300)
const value = z.string().max(4_000)
export const journeyStepSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("click"),
      name,
      role: z.enum(["button", "link", "checkbox", "radio"]).default("button"),
    })
    .strict(),
  z.object({ type: z.literal("fill"), name, value }).strict(),
  z.object({ type: z.literal("select"), name, value }).strict(),
  z
    .object({
      type: z.literal("check"),
      name,
      checked: z.boolean().default(true),
    })
    .strict(),
  z.object({ type: z.literal("expect_text"), text: name }).strict(),
  z.object({ type: z.literal("expect_value"), name, value }).strict(),
  z
    .object({
      type: z.literal("expect_selected"),
      name,
      selected: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      type: z.literal("expect_link"),
      name,
      href: z.string().url().optional(),
      message: value.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("expect_action"),
      actionId: name,
      input: z.record(z.string(), z.json()).default({}),
    })
    .strict(),
  z
    .object({
      type: z.literal("message"),
      message: z.string().trim().min(1).max(20_000),
    })
    .strict(),
])
export type JourneyStep = z.infer<typeof journeyStepSchema>

export const agentJourneySchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    required: z.boolean().default(true),
    width: z.number().int().min(240).max(1440).default(390),
    locale: z
      .string()
      .trim()
      .min(2)
      .max(35)
      .regex(
        /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/,
        "Use a language tag such as en or pt-BR."
      )
      .default("en"),
    steps: z.array(journeyStepSchema).min(1).max(80),
    actionMocks: z
      .array(
        z
          .object({
            actionId: name,
            response: z.json().optional(),
            error: z.string().max(2_000).optional(),
          })
          .strict()
      )
      .max(50)
      .default([]),
  })
  .strict()
export type AgentJourney = z.infer<typeof agentJourneySchema>

export const agentEvaluationInputSchema = z.union([
  z.string().trim().min(1).max(20_000),
  z
    .object({
      message: z.string().trim().min(1).max(20_000),
      channel: buildChannelSchema.default("web"),
      journey: agentJourneySchema.optional(),
    })
    .strict()
    .superRefine((input, context) => {
      if (input.journey && input.channel !== "web")
        context.addIssue({
          code: "custom",
          path: ["channel"],
          message: "Customer journeys require the web channel.",
        })
      if (
        input.journey?.actionMocks.some(
          (mock) => mock.response !== undefined && mock.error !== undefined
        )
      )
        context.addIssue({
          code: "custom",
          path: ["journey", "actionMocks"],
          message: "A mock must contain a response or an error, not both.",
        })
      if (
        input.journey &&
        new Set(input.journey.actionMocks.map((mock) => mock.actionId)).size !==
          input.journey.actionMocks.length
      )
        context.addIssue({
          code: "custom",
          path: ["journey", "actionMocks"],
          message: "Use one mock per action.",
        })
    }),
])
export type AgentEvaluationInput = z.infer<typeof agentEvaluationInputSchema>

export const journeyResultSchema = z.object({
  status: z.enum(["passed", "failed", "error"]),
  name: z.string(),
  fingerprint: z.string(),
  agentRevision: z.number(),
  width: z.number(),
  locale: z.string().optional(),
  steps: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["passed", "failed", "error", "skipped"]),
      error: z.string().nullable(),
    })
  ),
  error: z.string().nullable(),
})
export type JourneyResult = z.infer<typeof journeyResultSchema>
export const journeyResultAttribute = "datool.agent.journey"
export const agentFingerprintAttribute = "datool.agent.fingerprint"

export function readJourneyResult(
  attributes: Record<string, unknown> | undefined
): JourneyResult | null {
  const result = journeyResultSchema.safeParse(
    attributes?.[journeyResultAttribute]
  )
  return result.success ? result.data : null
}

export function journeyStepLabel(step: JourneyStep): string {
  switch (step.type) {
    case "click":
      return `Click ${step.name}`
    case "fill":
      return `Fill ${step.name}`
    case "select":
      return `Select ${step.name}`
    case "check":
      return `${step.checked ? "Check" : "Uncheck"} ${step.name}`
    case "expect_text":
      return `See ${step.text}`
    case "expect_value":
      return `Check value of ${step.name}`
    case "expect_selected":
      return `Check selection of ${step.name}`
    case "expect_link":
      return `Check link ${step.name}`
    case "expect_action":
      return `Check action ${step.actionId}`
    case "message":
      return `Send ${step.message.slice(0, 100)}`
  }
}
