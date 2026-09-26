"use client"

import type { ReactNode } from "react"
import { ChevronDown } from "lucide-react"
import { Button } from "./button"

export function ContentDisclosure({
  id,
  href,
  title,
  open,
  onToggle,
  children,
}: {
  id: string
  href: string
  title: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div>
      <h2>
        <Button
          asChild
          variant="ghost"
          className="h-auto w-full justify-between gap-6 px-3 py-5 text-left text-lg whitespace-normal"
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
            <span>{title}</span>
            <ChevronDown
              aria-hidden="true"
              className={open ? "rotate-180" : undefined}
            />
          </a>
        </Button>
      </h2>
      <div
        id={`${id}-answer`}
        aria-labelledby={`${id}-trigger`}
        hidden={!open}
        className="px-3 pt-3 pb-8"
      >
        {children}
      </div>
    </div>
  )
}
