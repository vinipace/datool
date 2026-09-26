import Link from "next/link"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import type { EvalRunSummary } from "@/src/lib/tracer/contracts"
import { uniqueEvalGroups } from "@/src/lib/tracer/eval-attribution"
import { SpanKindIcon } from "./span-kind-icon"
import { useWorkspaceHref } from "./workspace-path"

export function EvalGroupLinks({
  run,
  compact = false,
}: {
  run: Pick<EvalRunSummary, "groups" | "groupsResolvedAt">
  compact?: boolean
}) {
  const href = useWorkspaceHref()
  if (!run.groups?.length)
    return (
      <span className="text-foreground-muted">
        {run.groupsResolvedAt ? "Unassigned" : "Not resolved"}
      </span>
    )
  const groups = uniqueEvalGroups(
    run.groups.map((group) => ({ ...group, version: null }))
  )
  const links = groups.map((group) => (
    <Link
      key={JSON.stringify([group.type, group.name])}
      onClick={(event) => event.stopPropagation()}
      className="inline-flex min-w-0 items-center gap-1.5 rounded-sm hover:underline focus-visible:outline-ring"
      title={`${group.type === "agent" ? "Agent" : "Workflow"}: ${group.name}`}
      href={href(
        `/${group.type === "agent" ? "agents" : "workflows"}?${new URLSearchParams({ filter: `name = ${JSON.stringify(group.name)}` })}`
      )}
    >
      <SpanKindIcon kind={group.type} />
      <span className="truncate">{group.name}</span>
    </Link>
  ))
  if (compact)
    return (
      <span className="flex min-w-0 items-center gap-1">
        {links[0]}
        {groups.length > 1 ? (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost-muted"
                size="sm"
                onClick={(event) => event.stopPropagation()}
                aria-label={`Show all ${groups.length} operations`}
              >
                +{groups.length - 1}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              onClick={(event) => event.stopPropagation()}
              aria-label="Operations"
            >
              <div className="flex flex-col items-start gap-3">{links}</div>
            </PopoverContent>
          </Popover>
        ) : null}
      </span>
    )
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">{links}</span>
  )
}
