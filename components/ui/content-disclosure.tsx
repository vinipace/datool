"use client"

import type { ReactNode } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "./button"

export function ContentDisclosure({
  id,
  href,
  title,
  open,
  onToggle,
  children,
  contentPadding = "default",
  variant = "default",
}: {
  id: string
  href: string
  title: string
  open: boolean
  onToggle: () => void
  children: ReactNode
  contentPadding?: "default" | "none"
  variant?: "default" | "report"
}) {
  return (
    <div>
      <h2>
        <Button
          asChild
          variant="ghost"
          className={cn(
            "h-auto w-full justify-between gap-6 px-3 py-5 text-left text-lg whitespace-normal",
            variant === "report" && "justify-start gap-3 px-0 has-[>svg]:px-0"
          )}
        >
          <a
            id={`${id}-trigger`}
            href={href}
            role="button"
            aria-expanded={open}
            aria-controls={`${id}-answer`}
            onClick={(event) => {
              // Preserve the real destination for modified clicks and new tabs.
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return
              event.preventDefault()
              onToggle()
            }}
            onKeyDown={(event) => {
              if (event.key === " ") {
                event.preventDefault()
                onToggle()
              }
            }}
          >
            {variant === "report" && (
              <ChevronRight
                aria-hidden="true"
                className={cn(
                  "size-5 shrink-0 transition-transform duration-200 ease-out motion-reduce:transition-none",
                  open && "rotate-90"
                )}
              />
            )}
            <span>{title}</span>
            {variant === "default" && (
              <ChevronDown
                aria-hidden="true"
                className={open ? "rotate-180" : undefined}
              />
            )}
          </a>
        </Button>
      </h2>
      <div
        id={`${id}-answer`}
        aria-labelledby={`${id}-trigger`}
        hidden={!open}
        className={contentPadding === "none" ? undefined : "px-3 pt-3 pb-8"}
      >
        {children}
      </div>
    </div>
  )
}
