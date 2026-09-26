import type { ModelPriceIndicator as Price } from "@/src/lib/model-providers"

/** A pie, not a progress ring: more fill means a higher relative token price. */
export function ModelPriceIndicator({ price }: { price?: Price }) {
  const fraction = price?.fraction ?? 0
  const angle = fraction * Math.PI * 2
  const x = 10 + 8 * Math.sin(angle)
  const y = 10 - 8 * Math.cos(angle)
  const label = price ? `${price.level} model price` : "Model price unavailable"
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 20 20"
      role="img"
      aria-label={label}
      className="size-5 shrink-0 text-foreground"
    >
      <title>
        {price
          ? `${label}. Relative logarithmic scale using an equal mix of input and output token prices; highest rates for tiered models.`
          : label}
      </title>
      <circle cx="10" cy="10" r="8" fill="currentColor" opacity="0.12" />
      {!price && (
        <rect
          x="7"
          y="9.5"
          width="6"
          height="1"
          fill="currentColor"
          opacity="0.4"
        />
      )}
      {fraction >= 1 ? (
        <circle cx="10" cy="10" r="8" fill="currentColor" />
      ) : fraction > 0 ? (
        <path
          d={`M 10 10 L 10 2 A 8 8 0 ${fraction > 0.5 ? 1 : 0} 1 ${x} ${y} Z`}
          fill="currentColor"
        />
      ) : null}
    </svg>
  )
}
