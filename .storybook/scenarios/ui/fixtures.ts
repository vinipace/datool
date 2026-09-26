import type { ValueDocument } from "@/src/lib/tracer/dataset-editor"
import type { JsonObject } from "@/src/lib/tracer/contracts"

export function createTraceSchema(): JsonObject {
  return {
    type: "object",
    required: ["name", "enabled"],
    properties: {
      name: {
        type: "string",
        description: "A recognizable name for the captured workflow.",
      },
      priority: { type: "integer", enum: [1, 2, 3] },
      enabled: { type: "boolean" },
      metadata: { type: "object", properties: { region: { type: "string" } } },
    },
  }
}

export function createTraceValue(): JsonObject {
  return {
    name: "Invoice extraction",
    priority: 2,
    enabled: true,
    metadata: { region: "sa-east-1" },
  }
}

export function createTraceDocument(): ValueDocument {
  return {
    format: "json",
    text: JSON.stringify(createTraceValue(), null, 2),
  }
}

export function createScoreScript() {
  return [
    "export function score({ output }) {",
    "  return output?.invoiceNumber ? 1 : 0",
    "}",
  ].join("\n")
}
