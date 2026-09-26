"use client"

import { useState } from "react"
import { Cpu } from "lucide-react"
import { cn } from "@/lib/utils"

/** Same public logo source used by Vercel AI Elements; no project data is sent. */
export function ModelProviderLogo({
  provider,
  className,
}: {
  provider: string
  className?: string
}) {
  const [failed, setFailed] = useState<string | null>(null)
  const slug = provider === "meta" ? "llama" : provider
  const src =
    provider === "datool"
      ? "/icon.svg"
      : /^[a-z0-9-]+$/.test(slug)
        ? `https://models.dev/logos/${slug}.svg`
        : null
  if (!src || failed === src)
    return (
      <Cpu
        aria-hidden="true"
        className={cn("size-5 shrink-0 text-foreground-muted", className)}
      />
    )
  return (
    // Small third-party SVG marks do not need Next's image optimization service.
    <img
      src={src}
      alt=""
      aria-hidden="true"
      width={20}
      height={20}
      referrerPolicy="no-referrer"
      onError={() => setFailed(src)}
      className={cn(
        "size-5 shrink-0 object-contain",
        provider !== "datool" && "dark:invert",
        className
      )}
    />
  )
}
