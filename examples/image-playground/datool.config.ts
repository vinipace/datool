import { defineApps } from "../../src/lib/playground/contracts"

export default defineApps({
  apps: [
    {
      id: "misc.image-creation",
      name: "Image creation",
      type: "workflow",
      evaluatorIds: process.env.DATOOL_IMAGE_SCORER_ID
        ? [process.env.DATOOL_IMAGE_SCORER_ID]
        : [],
      inputSchema: {
        type: "object",
        required: ["prompt"],
        additionalProperties: false,
        properties: {
          prompt: {
            type: "string",
            minLength: 1,
            maxLength: 4000,
            description: "Describe the image you want to create.",
          },
          quality: {
            type: "string",
            enum: ["low", "medium", "high"],
            default: "low",
          },
        },
      },
      outputSchema: {
        type: "object",
        required: ["image", "model"],
        properties: {
          image: {
            type: "object",
            required: ["url", "alt"],
            properties: { url: { type: "string" }, alt: { type: "string" } },
          },
          model: { type: "string" },
        },
      },
      defaultInput: {
        prompt:
          "A small orange robot watering a single sunflower in a blue pot. Clean studio product illustration, pale cream background, soft shadows, no text.",
        quality: "low",
      },
      async handler({
        prompt,
        quality = "low",
      }: {
        prompt: string
        quality?: string
      }) {
        const key = process.env.OPENAI_API_KEY
        if (!key)
          throw new Error("Set OPENAI_API_KEY in the workflow environment.")
        const model = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1.5"
        const response = await fetch(
          "https://api.openai.com/v1/images/generations",
          {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(55_000),
            headers: {
              authorization: `Bearer ${key}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model,
              prompt,
              quality,
              n: 1,
              size: "1024x1024",
              output_format: "jpeg",
              output_compression: 75,
            }),
          }
        )
        if (!response.ok)
          throw new Error(`Image generation failed (HTTP ${response.status}).`)
        const result = (await response.json()) as {
          data?: { b64_json?: string }[]
        }
        const data = result.data?.[0]?.b64_json
        if (!data) throw new Error("The image provider returned no image.")
        if (data.length > 1_000_000)
          throw new Error(
            "Generated image exceeds the playground example's size limit."
          )
        return {
          image: { url: `data:image/jpeg;base64,${data}`, alt: prompt },
          model,
        }
      },
    },
  ],
})
