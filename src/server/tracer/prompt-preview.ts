import { promptTestSchema, renderPrompt } from "@/src/lib/tracer/prompts"
import { getProjectProviderKey } from "../model-providers/store"
import { OPENAI_PROVIDER, modelProviders } from "@/src/lib/model-providers"
import {
  openAIChatResult,
  openAIResponsesRequest,
  usesOpenAIResponses,
} from "../model-providers/openai"
import { TracerError, validation } from "./errors"

export async function previewPrompt(
  value: unknown,
  projectId: string,
  options: { apiKey?: string; fetch?: typeof fetch; signal?: AbortSignal } = {}
) {
  const parsed = promptTestSchema.safeParse(value)
  if (!parsed.success)
    throw validation(
      parsed.error.issues.map((issue) => issue.message).join(" ")
    )
  const { config, variables, messages } = parsed.data
  let rendered
  try {
    rendered = renderPrompt(config, variables)
  } catch (error) {
    throw validation((error as Error).message)
  }
  let apiKey = options.apiKey
  if (!apiKey) {
    try {
      apiKey = await getProjectProviderKey(projectId, config.provider)
    } catch {
      throw validation(
        `Configure ${modelProviders[config.provider].name} in this project’s settings to test prompts.`
      )
    }
  }
  const useResponses =
    config.provider === OPENAI_PROVIDER && usesOpenAIResponses(config.model)
  const body = {
    model: config.model,
    messages: [...rendered, ...messages],
    temperature: config.temperature,
    ...(config.provider === OPENAI_PROVIDER
      ? { max_completion_tokens: config.maxTokens }
      : { max_tokens: config.maxTokens }),
    ...(config.output === "json"
      ? { response_format: { type: "json_object" } }
      : {}),
  }
  const response = await (options.fetch ?? fetch)(
    `${modelProviders[config.provider].baseUrl}/${useResponses ? "responses" : "chat/completions"}`,
    {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(useResponses ? openAIResponsesRequest(body) : body),
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
    }
  )
  // Provider errors can contain credentials or submitted prompt content.
  if (!response.ok)
    throw new TracerError(
      "VALIDATION_ERROR",
      `Model request failed (${response.status}). Check the model and provider configuration.`
    )
  const raw = await response.json()
  if (useResponses && raw.status !== "completed")
    throw validation(
      "The model response did not complete. Try again or increase the output limit."
    )
  const result = (useResponses ? openAIChatResult(raw) : raw) as {
    choices?: { message?: { content?: string; refusal?: boolean | string } }[]
  }
  if (result.choices?.[0]?.message?.refusal)
    throw validation("The model declined this prompt. Try adjusting the prompt.")
  const content = result.choices?.[0]?.message?.content
  if (typeof content !== "string" || !content.trim())
    throw validation(
      "The model returned no text. Try another model or adjust the prompt."
    )
  return { role: "assistant" as const, content }
}
