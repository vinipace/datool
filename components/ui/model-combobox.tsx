"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Combobox, type ComboboxOption } from "./combobox"
import { Button } from "./button"
import { ModelProviderLogo } from "./model-provider-logo"
import { ModelDetails } from "./model-details"
import { HoverCard, HoverCardContent } from "./hover-card"
import {
  modelPriceIndicators,
  modelOptionValue,
  MODEL_PROVIDER_IDS,
  modelProviders,
  type ModelOption,
} from "@/src/lib/model-providers"
import { ModelPriceIndicator } from "./model-price-indicator"

/** Controlled model picker. Fetching, credentials, and persistence belong to its caller. */
export function ModelCombobox({
  models,
  value,
  onValueChange,
  loading = false,
  error,
  onRetry,
  disabled,
  modelType = "language",
  label = "Model",
  className,
  attentionRequest,
}: {
  models: ModelOption[]
  value: string
  onValueChange: (id: string) => void
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  disabled?: boolean
  modelType?: string | readonly string[]
  label?: string
  className?: string
  attentionRequest?: number
}) {
  const [preview, setPreview] = useState<{
    model: ModelOption
    anchor: HTMLElement
  } | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const close = () => {
    cancelClose()
    setPreview(null)
  }
  const scheduleClose = () => {
    cancelClose()
    closeTimer.current = setTimeout(() => setPreview(null), 150)
  }
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current)
    },
    []
  )
  const options = useMemo(() => {
    const filtered = models.filter(
      (model) =>
        !modelType ||
        (typeof modelType === "string"
          ? model.type === modelType
          : modelType.includes(model.type))
    )
    const prices = modelPriceIndicators(
      filtered.map((model) => ({ ...model, id: modelOptionValue(model) }))
    )
    const options: ComboboxOption[] = filtered
      .sort(
        (a, b) =>
          (a.provider ? MODEL_PROVIDER_IDS.indexOf(a.provider) : -1) -
            (b.provider ? MODEL_PROVIDER_IDS.indexOf(b.provider) : -1) ||
          a.creator.localeCompare(b.creator) ||
          a.name.localeCompare(b.name) ||
          (a.provider ?? "").localeCompare(b.provider ?? "")
      )
      .map((model) => ({
        value: modelOptionValue(model),
        label: model.name,
        trailing: (
          <ModelPriceIndicator price={prices.get(modelOptionValue(model))} />
        ),
        leading: <ModelProviderLogo provider={model.creator} />,
        group: model.provider ? modelProviders[model.provider].name : undefined,
        description: model.creator,
        keywords: [
          modelOptionValue(model),
          model.id,
          model.creator,
          ...model.tags,
          ...(model.provider
            ? [model.provider, modelProviders[model.provider].name]
            : []),
        ],
      }))
    // Preserve a saved selection even if it has left the catalog.
    if (value && !options.some((option) => option.value === value)) {
      const provider = MODEL_PROVIDER_IDS.find((id) =>
        value.startsWith(`${id}/`)
      )
      const modelId = provider ? value.slice(provider.length + 1) : value
      options.unshift({
        value,
        label: provider
          ? modelId
          : loading
            ? "Loading model…"
            : "Saved model (unavailable)",
        ...(provider
          ? {
              group: modelProviders[provider].name,
              description: modelId.includes("/")
                ? modelId.split("/")[0]
                : undefined,
            }
          : {}),
      })
    }
    return options
  }, [models, modelType, value, loading])
  return (
    <HoverCard
      open={Boolean(preview)}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <Combobox
        attentionRequest={attentionRequest}
        className={className}
        label={label}
        showSelectedDescription
        value={value || null}
        onValueChange={(id) => {
          close()
          onValueChange(id)
        }}
        onOpenChange={() => close()}
        onOptionMouseEnter={(option, anchor) => {
          cancelClose()
          const model = models.find(
            (model) => modelOptionValue(model) === option.value
          )
          setPreview(model ? { model, anchor } : null)
        }}
        onOptionMouseLeave={scheduleClose}
        options={options}
        disabled={disabled}
        virtualized
        placeholder={loading ? "Loading models…" : "Select a model…"}
        searchPlaceholder="Search models…"
        popupFooter={
          error ? (
            <div className="space-y-2 border-t border-border p-3 text-xs text-foreground-muted">
              <p role="alert">{error}</p>
              {onRetry && (
                <Button variant="outline" size="sm" onClick={onRetry}>
                  Retry models
                </Button>
              )}
            </div>
          ) : undefined
        }
      />
      {preview && (
        <HoverCardContent
          anchor={preview.anchor}
          side="right"
          align="start"
          role="region"
          aria-label="Model details"
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          className="max-h-[min(36rem,calc(100dvh-2rem))] w-96 overflow-y-auto"
        >
          <ModelDetails model={preview.model} />
        </HoverCardContent>
      )}
    </HoverCard>
  )
}
