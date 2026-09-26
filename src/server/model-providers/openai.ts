/** Older OpenAI models retain Chat Completions; modern models use Responses. */
export const usesOpenAIResponses = (model: string) =>
  !/^(gpt-3\.5|gpt-4-turbo)(?:-|$)/.test(model)

type ChatRequest = {
  model: string
  messages: {
    role: string
    content: string | { type: "image_url"; image_url: { url: string } }[]
  }[]
  temperature?: number
  max_completion_tokens?: number
  max_tokens?: number
  response_format?: {
    type: string
    json_schema?: { name: string; strict: boolean; schema: unknown }
  }
}

export function openAIResponsesRequest(request: ChatRequest) {
  const format = request.response_format
  return {
    model: request.model,
    store: false,
    input: request.messages.map((message) => ({
      role: message.role,
      content:
        typeof message.content === "string"
          ? message.content
          : message.content.map((part) => ({
              type: "input_image",
              image_url: part.image_url.url,
              detail: "auto",
            })),
    })),
    temperature: request.temperature,
    max_output_tokens: request.max_completion_tokens ?? request.max_tokens,
    ...(format
      ? {
          text: { format: { type: format.type, ...format.json_schema } },
        }
      : {}),
  }
}

type OpenAIResponse = {
  model?: string
  status?: string
  output?: {
    type: string
    content?: { type: string; text?: string; refusal?: string }[]
  }[]
  usage?: {
    input_tokens?: number
    output_tokens?: number
    input_tokens_details?: { cached_tokens?: number }
    output_tokens_details?: { reasoning_tokens?: number }
  }
}

/** Preserve the existing scorer parsing, refusal, completeness, and usage checks. */
export function openAIChatResult(response: OpenAIResponse) {
  const content = (response.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
  return {
    model: response.model,
    usage: response.usage
      ? {
          prompt_tokens: response.usage.input_tokens,
          completion_tokens: response.usage.output_tokens,
          prompt_tokens_details: response.usage.input_tokens_details,
          completion_tokens_details: response.usage.output_tokens_details,
        }
      : undefined,
    choices: [
      {
        finish_reason: response.status === "completed" ? "stop" : "incomplete",
        message: {
          content: content
            .filter((part) => part.type === "output_text")
            .map((part) => part.text ?? "")
            .join(""),
          refusal: content.some((part) => part.type === "refusal") || undefined,
        },
      },
    ],
  }
}
