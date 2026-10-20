"use client"

import { Avatar as AvatarPrimitive } from "radix-ui"
import { Check } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  agentAvatarColorSchema,
  agentAvatarStyleSchema,
  type AgentAppearance,
} from "@/src/lib/build/contracts"
import { isSafeHttpUrl } from "@/src/lib/build/urls"
import { Button } from "./button"

const colors = {
  orange: { label: "Orange", className: "bg-avatar-orange" },
  violet: { label: "Violet", className: "bg-avatar-violet" },
  blue: { label: "Blue", className: "bg-avatar-blue" },
  green: { label: "Green", className: "bg-avatar-green" },
  rose: { label: "Rose", className: "bg-avatar-rose" },
  yellow: { label: "Yellow", className: "bg-avatar-yellow" },
} satisfies Record<
  AgentAppearance["avatarColor"],
  { label: string; className: string }
>

type AvatarAppearance = Partial<
  Pick<AgentAppearance, "avatarUrl" | "avatarStyle" | "avatarColor">
>

/** Portrait adapted from the user-supplied Frame 121.svg; no shared SVG IDs. */
export function AgentAvatar({
  appearance = {},
  className,
}: {
  appearance?: AvatarAppearance
  className?: string
}) {
  const expression = appearance.avatarStyle ?? "friendly"
  const color = colors[appearance.avatarColor ?? "orange"] ?? colors.orange
  const image =
    appearance.avatarUrl && isSafeHttpUrl(appearance.avatarUrl)
      ? appearance.avatarUrl
      : undefined
  return (
    <AvatarPrimitive.Root
      aria-hidden
      data-slot="agent-avatar"
      className={cn(
        "relative inline-flex size-6 shrink-0 overflow-hidden rounded-md",
        color.className,
        className
      )}
    >
      <AvatarPrimitive.Image
        src={image}
        alt=""
        referrerPolicy="no-referrer"
        className="size-full object-cover"
      />
      <AvatarPrimitive.Fallback className="size-full">
        <svg
          viewBox="0 0 468 468"
          fill="none"
          className="size-full"
          aria-hidden
        >
          <path
            d="M118.748 387.91C160.43 439.828 142.514 486.628 128.346 503.539L310.701 519.535C294.248 514.203 258.874 492.113 249.002 446.41C236.662 389.281 303.012 444.691 367.91 374.766C432.809 304.84 392.967 175.39 331.268 97.6949C269.569 19.9996 168.108 17.2574 91.7836 97.6949C15.4594 178.132 66.6469 323.011 118.748 387.91Z"
            className="fill-avatar-paper stroke-avatar-paper"
            strokeWidth="18.2812"
            strokeLinecap="round"
          />
          <g
            className="stroke-avatar-ink"
            strokeLinecap="round"
            strokeWidth="18"
          >
            {expression === "calm" || expression === "happy" ? (
              <path d="M201 163Q223 139 245 160M300 144Q321 121 343 141" />
            ) : (
              <>
                <circle
                  cx="223"
                  cy="159"
                  r="22"
                  className="fill-avatar-ink"
                  stroke="none"
                />
                {expression === "wink" ? (
                  <path d="M301 145L341 137" />
                ) : (
                  <circle
                    cx="321"
                    cy="141"
                    r="22"
                    className="fill-avatar-ink"
                    stroke="none"
                  />
                )}
              </>
            )}
            <path
              d="M371.59 89.6795C346.626 71.6539 325.029 66.742 292.973 85.8692M245.867 106.395C201.003 94.1904 170.836 100.233 147.441 150.259"
              strokeWidth="26.5757"
            />
            {expression === "happy" ? (
              <path
                d="M223 252Q308 276 369 218Q348 323 279 316Q239 312 223 252Z"
                className="fill-avatar-ink"
                strokeWidth="10"
              />
            ) : expression === "calm" ? (
              <path d="M253 267Q296 281 332 259" />
            ) : (
              <path d="M239.717 261.395C311.47 261.395 341.388 250.878 376.671 211.149" />
            )}
          </g>
        </svg>
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  )
}

export function AgentAvatarPicker({
  value,
  onChange,
}: {
  value: AgentAppearance
  onChange: (value: AgentAppearance) => void
}) {
  return (
    <div className="flex flex-wrap items-start gap-6">
      <AgentAvatar appearance={value} className="size-20 rounded-2xl" />
      <div className="min-w-0 space-y-5">
        <fieldset className="space-y-2">
          <legend className="text-xs text-foreground-muted">Character</legend>
          <div className="flex flex-wrap gap-2">
            {agentAvatarStyleSchema.options.map((style) => (
              <Button
                key={style}
                type="button"
                variant="outline"
                className="size-12 rounded-xl p-1 aria-pressed:ring-2 aria-pressed:ring-ring"
                aria-label={`${style[0].toUpperCase()}${style.slice(1)} avatar`}
                title={`${style[0].toUpperCase()}${style.slice(1)}`}
                aria-pressed={
                  !value.avatarUrl &&
                  (value.avatarStyle ?? "friendly") === style
                }
                onClick={() =>
                  onChange({ ...value, avatarStyle: style, avatarUrl: null })
                }
              >
                <AgentAvatar
                  appearance={{ ...value, avatarStyle: style, avatarUrl: null }}
                  className="size-full rounded-lg"
                />
              </Button>
            ))}
          </div>
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="text-xs text-foreground-muted">Color</legend>
          <div className="flex flex-wrap gap-2">
            {agentAvatarColorSchema.options.map((color) => {
              const option = colors[color]
              return (
                <Button
                  key={color}
                  type="button"
                  variant="ghost"
                  className="size-8 rounded-full p-0.5 aria-pressed:ring-2 aria-pressed:ring-ring"
                  aria-label={`${option.label} avatar color`}
                  title={option.label}
                  aria-pressed={(value.avatarColor ?? "orange") === color}
                  onClick={() => onChange({ ...value, avatarColor: color })}
                >
                  <span
                    className={cn(
                      "grid size-full place-items-center rounded-full text-avatar-ink",
                      option.className
                    )}
                  >
                    {(value.avatarColor ?? "orange") === color ? (
                      <Check className="size-3.5" />
                    ) : null}
                  </span>
                </Button>
              )
            })}
          </div>
        </fieldset>
      </div>
    </div>
  )
}
