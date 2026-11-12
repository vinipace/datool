"use client"

import { Avatar as AvatarPrimitive } from "radix-ui"
import type { ReactNode } from "react"
import { Check } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  agentAvatarColorSchema,
  agentAvatarStyleSchema,
  type AgentAppearance,
} from "@/src/lib/build/contracts"
import { isSafeHttpUrl } from "@/src/lib/build/urls"
import { Button } from "./button"

import { agentAvatarColors as colors } from "./agent-avatar-colors"

const shapes: Partial<Record<AgentAppearance["avatarStyle"], ReactNode>> = {
  star: (
    <path d="M46 12Q50 3 54 12L65 34L89 37Q99 38 91 46L73 63L77 87Q79 97 70 92L50 81L30 92Q21 97 23 87L27 63L9 46Q1 38 11 37L35 34Z" />
  ),
  cube: (
    <>
      <path d="M13 31L33 12H89V69L70 88H13Z" />
      <path
        d="M13 31L33 12H89L70 31Z"
        className="fill-avatar-paper"
        opacity="0.35"
      />
      <path
        d="M70 31L89 12V69L70 88Z"
        className="fill-avatar-ink"
        opacity="0.25"
      />
      <rect x="13" y="31" width="57" height="57" rx="6" />
    </>
  ),
  circle: <circle cx="50" cy="50" r="39" />,
  flower: (
    <path d="M50 18C65-4 85 12 78 31C102 30 106 57 85 65C98 85 76 102 59 86C47 108 23 94 27 75C3 78-5 52 17 41C1 22 25 3 40 20Q45 12 50 18Z" />
  ),
  diamond: (
    <path d="M44 10Q50 4 56 10L90 44Q96 50 90 56L56 90Q50 96 44 90L10 56Q4 50 10 44Z" />
  ),
  arch: <path d="M15 85V47A35 35 0 0 1 85 47V85Q85 90 80 90H20Q15 90 15 85Z" />,
  triangle: <path d="M43 15Q50 2 57 15L92 78Q98 90 84 90H16Q2 90 8 78Z" />,
  heart: (
    <path d="M50 27C29-1 3 15 10 39C14 55 37 75 50 88C63 75 86 55 90 39C97 15 71-1 50 27Z" />
  ),
}

// Fit each silhouette closely, retaining a small margin around its outer points.
const shapeViewBoxes: Partial<Record<AgentAppearance["avatarStyle"], string>> =
  {
    star: "2 2 96 96",
    cube: "10 9 82 82",
    circle: "8 8 84 84",
    flower: "1 1 98 98",
    diamond: "4 4 92 92",
    arch: "8 9 84 84",
    triangle: "3 2 94 94",
    heart: "6 6 88 88",
  }

type AvatarAppearance = Partial<
  Pick<AgentAppearance, "avatarUrl" | "avatarStyle" | "avatarColor">
>

/** Shared artwork for agent cards, chat and settings; no shared SVG IDs. */
export function AgentAvatar({
  appearance = {},
  className,
}: {
  appearance?: AvatarAppearance
  className?: string
}) {
  const expression = appearance.avatarStyle ?? "friendly"
  const color = colors[appearance.avatarColor ?? "orange"] ?? colors.orange
  const shape = shapes[expression]
  const image =
    appearance.avatarUrl && isSafeHttpUrl(appearance.avatarUrl)
      ? appearance.avatarUrl
      : undefined
  return (
    <AvatarPrimitive.Root
      aria-hidden
      data-slot="agent-avatar"
      className={cn(
        "relative inline-flex size-6 shrink-0 rounded-md",
        shape && !image ? "overflow-visible" : "overflow-hidden",
        className
      )}
    >
      <AvatarPrimitive.Image
        src={image}
        alt=""
        referrerPolicy="no-referrer"
        className="size-full object-cover"
      />
      <AvatarPrimitive.Fallback
        className={cn("size-full", !shape && color.className)}
      >
        {shape ? (
          <svg
            viewBox={shapeViewBoxes[expression]}
            className={cn("size-full", color.artwork)}
            aria-hidden
          >
            <g fill="currentColor">{shape}</g>
            <g
              className={
                color.lightInk ? "fill-avatar-paper" : "fill-avatar-ink"
              }
            >
              <rect
                x={expression === "cube" ? 31 : 39}
                y={expression === "triangle" ? 57 : 46}
                width="6"
                height="16"
                rx="3"
              />
              <rect
                x={expression === "cube" ? 48 : 55}
                y={expression === "triangle" ? 57 : 46}
                width="6"
                height="16"
                rx="3"
              />
            </g>
          </svg>
        ) : (
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
        )}
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
      <AgentAvatar appearance={value} className="size-24 rounded-2xl" />
      <div className="min-w-0 space-y-5">
        <fieldset className="space-y-2">
          <legend className="text-xs text-foreground-muted">
            Shape & character
          </legend>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
            {agentAvatarStyleSchema.options.map((style) => (
              <Button
                key={style}
                type="button"
                variant="outline"
                className={cn(
                  "size-12 rounded-xl aria-pressed:ring-2 aria-pressed:ring-ring",
                  shapes[style] ? "p-0" : "p-1"
                )}
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
          <div className="grid w-fit grid-cols-7 gap-2">
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
                      "grid size-full place-items-center rounded-full",
                      option.className,
                      option.lightInk ? "text-avatar-paper" : "text-avatar-ink"
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
