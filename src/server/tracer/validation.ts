import { promptOverridesSchema, validatePromptOverrides } from "@/src/lib/tracer/prompt-overrides"
import { datasetPath } from "@/src/lib/tracer/dataset-library"
import { invocationGroupSchema } from "@/src/lib/tracer/groups"
import { datasetItemFields } from "@/src/lib/tracer/dataset-payload"
import { z, ZodError } from "zod"

import type {
  CreateDatasetInput,
  CreateDatasetItemInput,
  CreateEvalRunInput,
  CreateEvaluatorInput,
  CreateSavedViewInput,
  CreateSessionInput,
  CreateSpanInput,
  CreateTraceInput,
  JsonValue,
  PatchDatasetInput,
  PatchDatasetItemInput,
  PatchEvaluatorInput,
  PatchSavedViewInput,
  PatchSpanInput,
  PatchTraceInput,
} from "@/src/lib/tracer/contracts"
import { validation } from "@/src/server/tracer/errors"
import { inputOverridesSchema, validateInputOverrides } from "@/src/lib/tracer/eval-input-overrides"

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const name = z.string().trim().min(1).max(200)
const description = z.string().trim().max(4_000)
const timestamp = z.string().datetime({ offset: true })

export const datasetItemFieldsSchema = z.array(z.enum(datasetItemFields)).max(datasetItemFields.length)

export function parseDatasetItemFields(value: string | null) {
  return value === null ? undefined : parse(datasetItemFieldsSchema, value ? value.split(",") : [], "dataset item fields")
}

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ])
)
const jsonObject = z.record(z.string(), jsonValue)

const traceStatus = z.enum(["cancelled", "completed", "errored", "running"])
const spanKind = z.enum([
  "agent",
  "custom",
  "function",
  "llm",
  "score",
  "task",
  "tool",
  "workflow",
])
const evaluatorLanguage = z.enum(["javascript", "python"])
const viewResource = z.enum(["eval-results", "traces"])
const viewColumnFormat = z.enum(["boolean", "json", "number", "text"])

const createSpan = z
  .object({
    group: invocationGroupSchema.optional(),
    attributes: jsonObject.optional(),
    endedAt: timestamp.optional(),
    id: id.optional(),
    input: jsonValue.optional(),
    kind: spanKind.optional(),
    name,
    output: jsonValue.optional(),
    parentId: id.nullable().optional(),
    startedAt: timestamp.optional(),
    status: traceStatus.optional(),
  })
  .strict()

const patchSpan = createSpan
  .omit({ group: true })
  .partial()
  .extend({
    endedAt: timestamp.nullable().optional(),
    parentId: id.nullable().optional(),
  })
  .strict()

const createTrace = z
  .object({
    group: invocationGroupSchema.optional(),
    attributes: jsonObject.optional(),
    endedAt: timestamp.optional(),
    id: id.optional(),
    input: jsonValue.optional(),
    name: name.optional(),
    operation: name.optional(),
    output: jsonValue.optional(),
    sessionId: id.optional(),
    spans: z.array(createSpan).max(1_000).optional(),
    startedAt: timestamp.optional(),
    status: traceStatus.optional(),
  })
  .strict()

const patchTrace = createTrace
  .omit({
    id: true,
    sessionId: true,
    spans: true,
    startedAt: true,
    group: true,
  })
  .extend({ endedAt: timestamp.nullable().optional() })
  .strict()

const createSession = z
  .object({
    attributes: jsonObject.optional(),
    id: id.optional(),
    name: name.optional(),
  })
  .strict()

export const createDataset = z
  .object({
    description: description.optional(),
    id: id.optional(),
    name: datasetPath,
  })
  .strict()

export const patchDataset = z
  .object({
    metadata: jsonObject.optional(),
    fieldSchemas: z.object({
      input: z.object({ schema: jsonObject.nullable(), enforced: z.boolean() }).strict().optional(),
      expectedOutput: z.object({ schema: jsonObject.nullable(), enforced: z.boolean() }).strict().optional(),
      metadata: z.object({ schema: jsonObject.nullable(), enforced: z.boolean() }).strict().optional(),
    }).strict().optional(),
    description: description.nullable().optional(),
    name: datasetPath.optional(),
  })
  .strict()

export const createDatasetItem = z
  .object({
    sourceSpanId: id.optional(),
    expectedOutput: jsonValue.optional(),
    id: id.optional(),
    input: jsonValue,
    metadata: jsonObject.optional(),
    sourceTraceId: id.optional(),
  })
  .strict()

export const patchDatasetItem = z
  .object({
    sourceSpanId: id.nullable().optional(),
    expectedVersionId: id.optional(),
    expectedOutput: jsonValue.nullable().optional(),
    input: jsonValue.optional(),
    metadata: jsonObject.optional(),
    sourceTraceId: id.nullable().optional(),
  })
  .strict()

const createEvaluator = z
  .object({
    code: z.string().trim().min(1).max(100_000),
    description: description.optional(),
    id: id.optional(),
    language: evaluatorLanguage,
    name,
  })
  .strict()

const patchEvaluator = z
  .object({
    code: z.string().trim().min(1).max(100_000).optional(),
    description: description.nullable().optional(),
    name: name.optional(),
  })
  .strict()

export const createEvalRun = z
  .object({
    parentRunId: id.optional(),
    useRecordedVersions: z.boolean().optional(),
    promptOverrides: promptOverridesSchema.optional(),
    inputOverrides: inputOverridesSchema.optional(),
    datasetVersionId: id.optional(),
    evaluatorVersionIds: z.record(id, id).optional(),
    sourceRunId: id.optional(),
    background: z.boolean().optional(),
    mode: z.enum(["connected", "traces"]).optional(),
    appId: id.optional(),
    concurrency: z.number().int().min(1).max(16).optional(),
    metadata: jsonObject.optional(),
    datasetId: id.optional(),
    datasetItemIds: z.array(id).min(1).max(10_000).optional(),
    evaluatorIds: z.array(id).min(1).max(100).optional(),
    name: name.optional(),
    traceIds: z.array(id).min(1).max(10_000).optional(),
  })
  .strict()

const savedViewColumn = z
  .object({
    format: viewColumnFormat,
    id,
    label: name,
    selector: z.string().min(1).max(300),
  })
  .strict()

const savedViewFilter = z
  .object({
    operator: z.enum(["equals", "exists", "notEquals"]),
    selector: z.string().min(1).max(300),
    value: jsonValue.optional(),
  })
  .strict()

const savedViewSort = z
  .object({
    direction: z.enum(["asc", "desc"]),
    selector: z.string().min(1).max(300),
  })
  .strict()

export const createSavedView = z
  .object({
    columns: z.array(savedViewColumn).min(1).max(50),
    filters: z.array(savedViewFilter).max(20).optional(),
    id: id.optional(),
    name,
    resource: viewResource,
    sort: savedViewSort.nullable().optional(),
  })
  .strict()

export const patchSavedView = z
  .object({
    columns: z.array(savedViewColumn).min(1).max(50).optional(),
    filters: z.array(savedViewFilter).max(20).optional(),
    name: name.optional(),
    sort: savedViewSort.nullable().optional(),
  })
  .strict()

function parse<T>(schema: z.ZodType<T>, value: unknown, subject: string): T {
  try {
    return schema.parse(value)
  } catch (error) {
    if (error instanceof ZodError) {
      throw validation(`Invalid ${subject}.`, {
        issueCount: error.issues.length,
      })
    }
    throw error
  }
}

export function parseId(value: string, subject = "id") {
  return parse(id, value, subject)
}

export function parseCreateSession(value: unknown) {
  return parse(createSession, value, "session payload") as CreateSessionInput
}

export function parseCreateTrace(value: unknown) {
  const input = parse(createTrace, value, "trace payload") as CreateTraceInput
  return input
}

export function parsePatchTrace(value: unknown) {
  return parse(patchTrace, value, "trace patch") as PatchTraceInput
}

export function parseCreateSpan(value: unknown) {
  const input = parse(createSpan, value, "span payload") as CreateSpanInput
  return input
}

export function parsePatchSpan(value: unknown) {
  return parse(patchSpan, value, "span patch") as PatchSpanInput
}

export function parseCreateDataset(value: unknown) {
  return parse(createDataset, value, "dataset payload") as CreateDatasetInput
}

export function parsePatchDataset(value: unknown) {
  return parse(patchDataset, value, "dataset patch") as PatchDatasetInput
}

export function parseCreateDatasetItem(value: unknown) {
  return parse(
    createDatasetItem,
    value,
    "dataset item payload"
  ) as CreateDatasetItemInput
}

export function parsePatchDatasetItem(value: unknown) {
  return parse(
    patchDatasetItem,
    value,
    "dataset item patch"
  ) as PatchDatasetItemInput
}

export function parseCreateEvaluator(value: unknown) {
  return parse(
    createEvaluator,
    value,
    "evaluator payload"
  ) as CreateEvaluatorInput
}

export function parsePatchEvaluator(value: unknown) {
  return parse(patchEvaluator, value, "evaluator patch") as PatchEvaluatorInput
}

export function parseCreateEvalRun(value: unknown) {
  const input = parse(createEvalRun, value, "eval run payload") as CreateEvalRunInput
  if (!input.evaluatorIds?.length && !input.parentRunId && !input.sourceRunId) throw validation("Select evaluators or an existing run.")
  try { validateInputOverrides(input); validatePromptOverrides(input) } catch (error) {
    throw validation((error as Error).message)
  }
  return input
}

export function parseCreateSavedView(value: unknown) {
  return parse(
    createSavedView,
    value,
    "saved view payload"
  ) as CreateSavedViewInput
}

export function parsePatchSavedView(value: unknown) {
  return parse(patchSavedView, value, "saved view patch") as PatchSavedViewInput
}

export function parseListLimit(value: string | null, fallback = 50) {
  if (value === null) {
    return fallback
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 200) {
    throw validation("limit must be an integer between 1 and 200.")
  }
  return parsed
}
