import type { ReactNode } from "react"
import Link from "next/link"
import type { AgentAppearance } from "@/src/lib/build/contracts"
import { cn } from "@/lib/utils"
import { AgentAvatar } from "./agent-avatar"
import { Card, CardAction } from "./card"

import { agentAvatarColors } from "./agent-avatar-colors"

export function AgentCard({
  name,
  appearance,
  href,
  subtitle,
  actions,
}: {
  name: string
  appearance: AgentAppearance
  href: string
  subtitle: ReactNode
  actions?: ReactNode
}) {
  return (
    <Card className="relative min-w-0">
      <CardAction asChild variant="preview" className="gap-0 overflow-hidden">
        <Link href={href} aria-label={`Open ${name}`}>
          <div
            aria-hidden="true"
            className={cn(
              "flex h-32 items-end justify-center overflow-hidden px-5 pt-5",
              agentAvatarColors[appearance.avatarColor].preview
            )}
          >
            <div className="h-full w-4/5 max-w-48 overflow-hidden rounded-t-xl border border-border bg-background shadow-sm transition-transform group-hover:translate-y-1 motion-reduce:transition-none">
              <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-2">
                <AgentAvatar
                  appearance={appearance}
                  className="size-4 rounded-full"
                />
                <span className="truncate text-[10px] font-medium">{name}</span>
              </div>
              <div className="space-y-2 p-2.5">
                <div className="h-4 w-3/5 rounded-full bg-muted" />
                <div data-bubble className="ml-auto h-4 w-1/2 rounded-full" />
                <div className="h-4 w-2/5 rounded-full bg-muted" />
              </div>
            </div>
          </div>
          <div className="min-w-0 border-t border-border p-3 pr-12">
            <h3 className="truncate text-sm font-medium">{name}</h3>
            <div className="mt-1 truncate text-xs text-foreground-muted">
              {subtitle}
            </div>
          </div>
        </Link>
      </CardAction>
      {actions && <div className="absolute right-2 bottom-4">{actions}</div>}
    </Card>
  )
}
