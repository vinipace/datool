import type {
  SemanticMemberDefinition,
  SemanticMeasureAggregation,
} from "@/src/lib/semantic/model"
import { labelFilterOperators } from "./common"

export type MeasureSpec = readonly [
  key: string,
  title: string,
  aggregation: SemanticMeasureAggregation,
  unit: string,
  definition: string,
  denominator?: string,
]
export function sourceMeasures(
  model: string,
  specs: readonly MeasureSpec[],
  factIdentity: string,
  eventTime: string
): SemanticMemberDefinition[] {
  return specs.map(
    ([key, title, aggregation, unit, definition, denominator]) => ({
      name: `${model}.${key}`,
      kind: "measure",
      type: "number",
      title,
      description: definition,
      definition,
      aggregation,
      unit,
      metricVersion: "v1",
      factIdentity,
      eventTime,
      denominator,
      format:
        unit === "USD"
          ? "currency"
          : unit === "ms"
            ? "durationMilliseconds"
            : unit === "ratio"
              ? "percent"
              : unit === "value"
                ? "number"
                : "integer",
      ...(unit === "USD" ? { currency: "USD" } : {}),
    })
  )
}
export function sourceDimension(
  model: string,
  key: string,
  title: string,
  definition: string,
  extra: Partial<Extract<SemanticMemberDefinition, { kind: "dimension" }>> = {}
): SemanticMemberDefinition {
  return {
    name: `${model}.${key}`,
    title,
    description: definition,
    definition,
    kind: "dimension",
    type: "string",
    filterOperators: labelFilterOperators,
    groupable: true,
    metricVersion: "v1",
    missingBehavior: "Unknown (null)",
    cardinality: "low",
    multiplicity: "one",
    ...extra,
  }
}
export function sourceTime(
  model: string,
  key: string,
  title: string,
  definition: string
): SemanticMemberDefinition {
  return {
    name: `${model}.${key}`,
    title,
    description: definition,
    definition,
    kind: "timeDimension",
    type: "date",
    granularities: ["day", "week", "month"],
    metricVersion: "v1",
  }
}
export function metadataDimension(
  model: string,
  key: string,
  title: string,
  definition: string
): SemanticMemberDefinition {
  return sourceDimension(model, key, title, definition, {
    groupable: false,
    filterValueType: "json",
    filterOperators: [
      "equals",
      "notEquals",
      "in",
      "notIn",
      "contains",
      "notContains",
      "gt",
      "gte",
      "lt",
      "lte",
      "set",
      "notSet",
    ],
    source: title,
    unavailableReason:
      "Choose a typed metadata path to filter; arbitrary JSON documents cannot be grouped.",
  })
}
