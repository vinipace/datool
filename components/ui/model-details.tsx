import { ModelProviderLogo } from "./model-provider-logo"
import { modelTokenPrice, type ModelOption } from "@/src/lib/model-providers"

export function ModelDetails({ model }: { model: ModelOption }) {
  const tokens = (value?: number) =>
    value === undefined
      ? "Not available"
      : `${value.toLocaleString("en-US")} tokens`
  const rows = [
    ["Context", tokens(model.contextWindow)],
    ["Max output", tokens(model.maxOutputTokens)],
    [
      "Input pricing",
      modelTokenPrice(model.pricing?.input, model.pricing?.inputTiers),
    ],
    [
      "Output pricing",
      modelTokenPrice(model.pricing?.output, model.pricing?.outputTiers),
    ],
    ...(model.pricing?.cacheRead !== undefined
      ? [["Cached input", modelTokenPrice(model.pricing.cacheRead)]]
      : []),
  ]
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <ModelProviderLogo provider={model.creator} />
        <h3 className="text-base font-medium">{model.name}</h3>
      </div>
      {model.description && (
        <p className="text-sm leading-relaxed text-foreground-muted">
          {model.description}
        </p>
      )}
      <dl className="divide-y divide-border text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[7rem_1fr] gap-3 py-3">
            <dt className="text-foreground-muted">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {model.pricing?.inputTiers?.length ||
      model.pricing?.outputTiers?.length ? (
        <p className="text-xs text-foreground-muted">
          Rates vary by context length.
        </p>
      ) : null}
      {model.modalities && (
        <p className="text-xs text-foreground-muted">
          Input: {model.modalities.input.join(", ")} · Output:{" "}
          {model.modalities.output.join(", ")}
        </p>
      )}
      {model.tags.length > 0 && (
        <p className="text-xs text-foreground-muted">
          {model.tags.map((tag) => tag.replaceAll("-", " ")).join(" · ")}
        </p>
      )}
    </div>
  )
}
