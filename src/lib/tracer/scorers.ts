import {
  DATOOL_PROVIDER,
  DATOOL_SCORER_MODEL,
} from "@/src/lib/execution-credits"
import { z } from "zod"
import {
  libraryScorerSchema,
  libraryEvaluator,
  validLibraryMapping,
  defaultLibraryScorer,
  type LibraryEvaluatorId,
} from "./scorer-libraries"
import {
  GATEWAY_PROVIDER,
  OPENAI_PROVIDER,
  TYPESAFE_PROVIDER,
  MODEL_PROVIDER_IDS,
  isGatewayModelId,
  isOpenAIModelId,
} from "@/src/lib/model-providers"

export const scorerInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "Use lowercase letters, numbers, and hyphens."
      ),
    description: z.string().max(4000).default(""),
    type: z.enum(["llm", "javascript", "python", "library"]),
    library: libraryScorerSchema.optional(),
    code: z.string().max(128_000).default(""),
    model: z.string().max(200).default(""),
    provider: z.enum(MODEL_PROVIDER_IDS).optional(),
    modelType: z.enum(["language", "evaluation"]).optional(),
    chainOfThought: z.boolean().default(false),
    imagePaths: z.array(z.string().trim().min(1).max(200)).max(4).optional(),
    messages: z
      .array(
        z.object({
          role: z.enum(["system", "user"]),
          content: z.string().max(32000),
        })
      )
      .max(20)
      .default([]),
    choices: z
      .array(
        z.object({
          label: z.string().max(120),
          score: z.number().min(0).max(1),
        })
      )
      .max(50)
      .default([]),
    allowSkip: z.boolean().default(false),
    threshold: z.number().min(0).max(1).nullable().default(null),
  })
  .superRefine((value, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message })
    if (
      value.provider === DATOOL_PROVIDER &&
      (value.model !== DATOOL_SCORER_MODEL ||
        value.modelType === "evaluation" ||
        value.imagePaths?.length)
    )
      issue("Datool Scorer Model uses GPT-6 Luna with text evidence only.")
    if (["javascript", "python"].includes(value.type) && !value.code.trim())
      issue("Scorer code is required.")
    if (value.type === "library") {
      if (!value.library) issue("Select a library evaluator.")
      else {
        const entry = libraryEvaluator(value.library.evaluator)
        for (const argument of entry.arguments) {
          if (!validLibraryMapping(value.library.mappings[argument] ?? ""))
            issue(
              `Map ${argument} to a trace or datasetItem field using a dotted path.`
            )
        }
        if (value.library.options.schema && entry.id !== "ValidJSON")
          issue("JSON Schema is only supported by ValidJSON.")
        if (entry.modelRequired) {
          if (
            value.provider !== GATEWAY_PROVIDER &&
            value.provider !== DATOOL_PROVIDER
          )
            issue(
              "Select Datool or Vercel AI Gateway for this library evaluator."
            )
          if (
            value.provider !== DATOOL_PROVIDER &&
            !isGatewayModelId(value.model)
          )
            issue("Select a language model for the library evaluator.")
          if (value.modelType === "evaluation")
            issue("Library evaluators require a language model.")
        }
      }
    }
    if (value.type === "llm") {
      if (value.modelType === "evaluation") {
        if (!value.provider)
          issue("Evaluation models require a project AI provider.")
        if (value.chainOfThought)
          issue("Evaluation models do not return chain-of-thought reasoning.")
        if (value.imagePaths?.length)
          issue("Evaluation models currently support text evidence only.")
      }
      if (value.provider === TYPESAFE_PROVIDER) {
        if (value.modelType !== "evaluation")
          issue("TypeSafe AI supports evaluation models only.")
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.model))
          issue("Use a direct TypeSafe model ID, for example jev-latest.")
      }
      if (value.provider === OPENAI_PROVIDER) {
        if (value.modelType === "evaluation")
          issue("OpenAI supports language models only for scoring.")
        if (value.model.trim() && !isOpenAIModelId(value.model))
          issue("Use a direct OpenAI model ID, for example gpt-4.1-mini.")
      }
      if (!value.model.trim()) issue("Select a model for the LLM scorer.")
      else if (
        value.provider === GATEWAY_PROVIDER &&
        !isGatewayModelId(value.model)
      )
        issue(
          "Gateway models use creator/model IDs, for example openai/gpt-4.1-mini."
        )
      if (
        value.messages.some((m) => !m.content.trim()) ||
        value.choices.some((c) => !c.label.trim())
      )
        issue("Messages and choice labels cannot be empty.")
      if (!value.messages.length || !value.choices.length)
        issue("LLM scorers require messages and choice scores.")
      if (
        new Set(value.choices.map((c) => c.label)).size !==
          value.choices.length ||
        new Set(value.choices.map((c) => c.score)).size !== value.choices.length
      )
        issue("Choice labels and scores must be unique.")
    }
  })
export type ScorerInput = z.infer<typeof scorerInputSchema>
export type Scorer = ScorerInput & {
  id: string
  createdAt: string
  updatedAt: string
  revision: number
}
export const defaultScorer: ScorerInput = {
  name: "",
  slug: "",
  description: "",
  type: "llm",
  model: "",
  chainOfThought: false,
  messages: [
    {
      role: "user",
      content:
        "Evaluate the output against the expected answer.\nInput: {{input}}\nOutput: {{output}}\nExpected: {{expected}}",
    },
  ],
  choices: [
    { label: "Fail", score: 0 },
    { label: "Pass", score: 1 },
  ],
  allowSkip: false,
  threshold: null,
  code: "function evaluate({ trace, datasetItem }) {\n  const expected = datasetItem?.expectedOutput\n  const matches = JSON.stringify(trace.output) === JSON.stringify(expected)\n  return { score: matches ? 1 : 0, passed: matches }\n}",
}

export const defaultPythonScorerCode = `def evaluate(trace, dataset_item=None):
    expected = (dataset_item or {}).get("expectedOutput")
    matches = trace.get("output") == expected
    return {"score": 1 if matches else 0, "passed": matches}
`

/** Defaults used by the shared picker; saved scorers remain editable as usual. */
export function libraryScorerPreset(
  evaluator: LibraryEvaluatorId
): ScorerInput {
  const entry = libraryEvaluator(evaluator)
  const library = defaultLibraryScorer(evaluator)
  return {
    ...defaultScorer,
    name: `AutoEvals: ${entry.name}`,
    slug: `autoevals-${evaluator.toLowerCase()}-${library.version.replaceAll(".", "-")}-${library.adapterVersion}`,
    description: entry.description,
    type: "library",
    code: "",
    messages: [],
    choices: [],
    library,
    ...(entry.modelRequired
      ? {
          provider: GATEWAY_PROVIDER,
          model: "openai/gpt-4.1-mini",
          modelType: "language",
        }
      : {}),
  }
}
