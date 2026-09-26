"use client"

import { ProjectModelField } from "./project-model-field"

const scorerModelTypes = ["language", "evaluation"] as const

export function ScorerModelField(
  props: Omit<Parameters<typeof ProjectModelField>[0], "modelType">
) {
  return (
    <ProjectModelField
      {...props}
      includeDatoolScorer
      modelType={scorerModelTypes}
    />
  )
}
