"use client"

import { useState } from "react"
import { Box } from "lucide-react"
import { cn } from "@/lib/utils"

/** Public app artwork; no account identifiers or referrer are sent. */
export function IntegrationLogo({
  slug,
  size = "default",
}: {
  slug: string
  size?: "sm" | "default"
}) {
  const [failed, setFailed] = useState<string | null>(null)
  const src = /^[a-z][a-z0-9_]+$/.test(slug)
    ? `https://logos.composio.dev/api/${slug === "shopify_native" ? "shopify" : slug}`
    : null
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center border border-border bg-background",
        size === "sm" ? "size-9 rounded-lg" : "size-14 rounded-xl"
      )}
    >
      {src && failed !== src ? (
        <img
          src={src}
          alt=""
          width={size === "sm" ? 20 : 32}
          height={size === "sm" ? 20 : 32}
          referrerPolicy="no-referrer"
          onError={() => setFailed(src)}
          className={cn(
            "object-contain",
            size === "sm" ? "size-5" : "size-8",
            slug === "github" && "dark:invert"
          )}
        />
      ) : (
        <Box
          className={cn(
            "text-foreground-muted",
            size === "sm" ? "size-5" : "size-8"
          )}
        />
      )}
    </span>
  )
}
