import Link from "next/link"
import { Layers } from "lucide-react"
import type { InvocationGroup } from "@/src/lib/tracer/groups"
import { SpanKindIcon } from "./span-kind-icon"

export function InspectorGroupMembership({
  traceGroup,
  spanGroup,
  isRootSelected,
  workspaceHref,
}: {
  traceGroup?: InvocationGroup | null
  spanGroup?: InvocationGroup | null
  isRootSelected: boolean
  workspaceHref: (path: string) => string
}) {
  const group = isRootSelected ? traceGroup : spanGroup
  if (!group) return null

  return (
    <section
      aria-label="Group membership"
      className="border-t border-border pt-3"
    >
      <h3 className="mb-4 flex items-center gap-2 text-sm font-medium text-foreground">
        <Layers aria-hidden="true" className="size-4 text-foreground-muted" />
        Group membership
      </h3>
      <Link
        className="inline-flex max-w-full items-start gap-2 rounded-sm text-sm text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        href={workspaceHref(
          `/${group.type === "agent" ? "agents" : "workflows"}?${new URLSearchParams(
            {
              filter: `startedAt >= -7d name = ${JSON.stringify(group.name)} version = ${JSON.stringify(group.version ?? null)}`,
            }
          )}`
        )}
      >
        <SpanKindIcon kind={group.type} />
        <span className="min-w-0 break-words">
          {group.type === "agent" ? "Agent" : "Workflow"}: {group.name}
          {group.version ? (
            <span className="text-foreground-muted"> · {group.version}</span>
          ) : null}
        </span>
      </Link>
    </section>
  )
}
