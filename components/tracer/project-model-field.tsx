"use client"

import { useCallback, useMemo } from "react"
import { FormRow } from "@/components/ui/form-row"
import { ModelCombobox } from "@/components/ui/model-combobox"
import { workspaceRequest } from "@/lib/workspace-api"
import {
  GATEWAY_PROVIDER,
  modelOptionValue,
  projectModels,
  type ModelCatalog,
  type ModelProvider,
} from "@/src/lib/model-providers"
import { useRemote } from "./hooks"
import { useProjectScope } from "./project-scope-context"

export function ProjectModelField({
  model,
  provider,
  onChange,
  attentionRequest,
  disabled,
  includeDatoolScorer = false,
  modelType = "language",
}: {
  model: string
  provider?: ModelProvider
  onChange: (selection: {
    provider: ModelProvider
    model: string
    modelType: "language" | "evaluation"
  }) => void
  attentionRequest?: number
  disabled?: boolean
  includeDatoolScorer?: boolean
  modelType?: "language" | readonly ("language" | "evaluation")[]
}) {
  const projectId = useProjectScope()?.projectId
  const load = useCallback(
    (signal: AbortSignal) =>
      workspaceRequest<ModelCatalog>(
        `/api/projects/${encodeURIComponent(projectId ?? "")}/providers/models`,
        { signal }
      ),
    [projectId]
  )
  const catalog = useRemote(load, [projectId], { enabled: Boolean(projectId) })
  const models = useMemo(
    () =>
      projectModels(
        catalog.data?.models ?? [],
        includeDatoolScorer && catalog.data?.datoolModel
      ),
    [catalog.data, includeDatoolScorer]
  )
  const selected =
    model && !provider && !model.includes("/") ? `openai/${model}` : model
  return (
    <FormRow label="Model" controlWidth="wide">
      <ModelCombobox
        attentionRequest={attentionRequest}
        className="w-full min-w-0"
        disabled={disabled}
        models={models}
        modelType={modelType}
        value={
          selected
            ? modelOptionValue({
                id: selected,
                provider: provider ?? GATEWAY_PROVIDER,
              })
            : ""
        }
        onValueChange={(value) => {
          const model = models.find(
            (model) => modelOptionValue(model) === value
          )
          if (!model) return
          onChange({
            provider: model.provider,
            model: model.id,
            modelType: model.type === "evaluation" ? "evaluation" : "language",
          })
        }}
        loading={catalog.isLoading}
        error={catalog.error?.message}
        onRetry={catalog.refresh}
      />
    </FormRow>
  )
}
