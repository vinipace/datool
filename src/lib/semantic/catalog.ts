import {
  defineSemanticModel,
  type SemanticMemberDefinition,
  type SemanticModel,
  type SemanticSourcePresentation,
} from "@/src/lib/semantic/model"
import type {
  SemanticMemberName,
  SemanticOrder,
} from "@/src/lib/semantic/query"

/** Serializable metadata deliberately excludes executable model functions. */
export type SemanticCatalogModelMetadata = Readonly<{
  source?: SemanticSourcePresentation
  name: string
  version: string
  members: readonly SemanticMemberDefinition[]
  defaultMeasures?: readonly SemanticMemberName[]
  defaultOrder?: readonly SemanticOrder[]
  maxWindowDays?: number
  maxLimit?: number
}>

export type SemanticCatalogMetadata = Readonly<{
  models: readonly SemanticCatalogModelMetadata[]
}>

export type SemanticCatalog = Readonly<{
  getModel: (name: string) => SemanticModel | undefined
  getMember: (name: string) => SemanticMemberDefinition | undefined
  getMembers: (modelName: string) => readonly SemanticMemberDefinition[]
  metadata: () => SemanticCatalogMetadata
}>

/** Build a static, immutable catalog. Requests cannot register executable code. */
export function createSemanticCatalog(
  models: readonly SemanticModel[]
): SemanticCatalog {
  if (!Array.isArray(models))
    throw new TypeError("Semantic catalog models must be an array.")
  const normalized = models.map((model) => defineSemanticModel(model))
  const modelByName = new Map<string, SemanticModel>()
  const memberByName = new Map<string, SemanticMemberDefinition>()
  for (const model of normalized) {
    if (modelByName.has(model.name))
      throw new TypeError(
        `Semantic catalog contains duplicate model '${model.name}'.`
      )
    modelByName.set(model.name, model)
    for (const member of model.members) {
      if (memberByName.has(member.name))
        throw new TypeError(
          `Semantic catalog contains duplicate member '${member.name}'.`
        )
      memberByName.set(member.name, member)
    }
  }

  const sortedModels = Object.freeze(
    [...normalized].sort((left, right) => compareNames(left.name, right.name))
  )
  const membersByModel = new Map<string, readonly SemanticMemberDefinition[]>()
  for (const model of sortedModels) {
    membersByModel.set(
      model.name,
      Object.freeze(
        [...model.members].sort((left, right) =>
          compareNames(left.name, right.name)
        )
      )
    )
  }
  const metadata = Object.freeze({
    models: Object.freeze(
      sortedModels.map((model) =>
        Object.freeze({
          ...(model.source ? { source: model.source } : {}),
          name: model.name,
          version: model.version,
          members: membersByModel.get(model.name)!,
          ...(model.defaultMeasures
            ? { defaultMeasures: Object.freeze([...model.defaultMeasures]) }
            : {}),
          ...(model.defaultOrder
            ? {
                defaultOrder: Object.freeze(
                  model.defaultOrder.map(
                    (order: SemanticOrder) =>
                      [order[0], order[1]] as SemanticOrder
                  )
                ),
              }
            : {}),
          ...(model.maxWindowDays !== undefined
            ? { maxWindowDays: model.maxWindowDays }
            : {}),
          ...(model.maxLimit !== undefined ? { maxLimit: model.maxLimit } : {}),
        })
      )
    ),
  })

  return Object.freeze({
    getModel: (name) => modelByName.get(name),
    getMember: (name) => memberByName.get(name),
    getMembers: (name) => membersByModel.get(name) ?? [],
    metadata: () => metadata,
  })
}

function compareNames(left: string, right: string) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
