import { z } from "zod"

export const AUTOEVALS_VERSION = "0.3.0" as const
export const LIBRARY_ADAPTER_VERSION = 1 as const
export const libraryEvaluatorIds = [
  "ExactMatch",
  "Levenshtein",
  "NumericDiff",
  "ValidJSON",
  "JSONDiff",
  "Factuality",
] as const
export type LibraryEvaluatorId = (typeof libraryEvaluatorIds)[number]
export type LibraryArgument = "input" | "output" | "expected"

/** Browser-safe discovery; implementations and credentials stay on the server. */
export const scorerLibraries = [
  {
    id: "autoevals" as const,
    name: "AutoEvals",
    version: AUTOEVALS_VERSION,
    adapterVersion: LIBRARY_ADAPTER_VERSION,
    docsUrl: "/docs/evaluation/scorers",
    evaluators: [
      {
        id: "ExactMatch",
        name: "Exact match",
        description: "Compare two JSON values for exact equality.",
        modelRequired: false,
        arguments: ["output", "expected"],
        valueType: "json",
      },
      {
        id: "Levenshtein",
        name: "Text similarity",
        description: "Compare strings using normalized edit distance.",
        modelRequired: false,
        arguments: ["output", "expected"],
        valueType: "string",
      },
      {
        id: "NumericDiff",
        name: "Numeric similarity",
        description: "Compare numbers using their normalized difference.",
        modelRequired: false,
        arguments: ["output", "expected"],
        valueType: "number",
      },
      {
        id: "ValidJSON",
        name: "Valid JSON",
        description: "Check valid JSON, optionally against a JSON Schema.",
        modelRequired: false,
        arguments: ["output"],
        valueType: "json",
      },
      {
        id: "JSONDiff",
        name: "JSON similarity",
        description:
          "Compare JSON structure and values, including nested objects and arrays.",
        modelRequired: false,
        arguments: ["output", "expected"],
        valueType: "json",
      },
      {
        id: "Factuality",
        name: "Factuality",
        description:
          "Use a language model to compare an answer against a reference answer.",
        modelRequired: true,
        arguments: ["input", "output", "expected"],
        valueType: "string",
      },
    ] satisfies {
      id: LibraryEvaluatorId
      name: string
      description: string
      modelRequired: boolean
      arguments: LibraryArgument[]
      valueType: "json" | "string" | "number"
    }[],
  },
]

export const libraryEvaluator = (id: LibraryEvaluatorId) =>
  scorerLibraries[0].evaluators.find((entry) => entry.id === id)!
export const defaultLibraryMappings = {
  input: "trace.input",
  output: "trace.output",
  expected: "datasetItem.expectedOutput",
}
const mapping = z.string().trim().max(300)
export const libraryScorerSchema = z
  .object({
    package: z.literal("autoevals"),
    version: z.literal(AUTOEVALS_VERSION),
    adapterVersion: z.literal(LIBRARY_ADAPTER_VERSION),
    evaluator: z.enum(libraryEvaluatorIds),
    mappings: z
      .object({
        input: mapping.optional(),
        output: mapping,
        expected: mapping.optional(),
      })
      .strict(),
    options: z
      .object({ schema: z.record(z.string(), z.json()).optional() })
      .strict()
      .default({}),
  })
  .strict()
export type LibraryScorerConfig = z.infer<typeof libraryScorerSchema>

export function defaultLibraryScorer(
  evaluator: LibraryEvaluatorId = "ExactMatch"
): LibraryScorerConfig {
  return {
    package: "autoevals",
    version: AUTOEVALS_VERSION,
    adapterVersion: LIBRARY_ADAPTER_VERSION,
    evaluator,
    mappings: { ...defaultLibraryMappings },
    options: {},
  }
}

export function validLibraryMapping(path: string) {
  const parts = path.split(".")
  return (
    ["trace", "datasetItem"].includes(parts[0]) &&
    parts.length > 1 &&
    parts.every(
      (part) =>
        /^[A-Za-z0-9_$-]+$/.test(part) &&
        !["__proto__", "prototype", "constructor"].includes(part)
    )
  )
}

/** Temporary selector value, resolved to a project scorer before evaluation. */
export const librarySelectionId = (id: LibraryEvaluatorId) => `autoevals:${id}`
export const librarySelectionEvaluator = (value: string) =>
  libraryEvaluatorIds.find((id) => librarySelectionId(id) === value)
