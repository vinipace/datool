import type { ReactNode } from "react"
import { ChevronDown } from "lucide-react"

/** Collapsible settings group with consistent spacing and disclosure affordance. */
export function SettingsSection({
  title,
  children,
  defaultOpen = true,
}: {
  title: string
  children: ReactNode
  defaultOpen?: boolean
}) {
  return (
    <details
      open={defaultOpen}
      className="group/settings border-b border-border last:border-0"
    >
      <summary className="flex w-full cursor-pointer list-none items-center justify-between px-4 py-7 text-sm font-semibold underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
        <span className="pr-3">{title}</span>
        <ChevronDown
          aria-hidden
          className="size-4 shrink-0 text-foreground-muted transition-transform group-open/settings:rotate-180"
        />
      </summary>
      <div className="px-4 pb-7">{children}</div>
    </details>
  )
}
