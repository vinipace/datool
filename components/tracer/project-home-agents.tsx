"use client"

import Link from "next/link"
import {
  Bot,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Settings,
  ArrowUpRight,
} from "lucide-react"
import { AgentCard } from "@/components/ui/agent-card"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import { Skeleton } from "@/components/ui/skeleton"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  buildCall,
  buildOperations,
  listItems,
} from "@/components/build/shared/build-api"
import type { ManagedAgent } from "@/src/lib/build/contracts"
import { formatDate, formatRelative } from "./format"
import { useRemote } from "./hooks"
import { useProjectScope } from "./project-scope-context"
import { useWorkspaceHref } from "./workspace-path"

export function ProjectHomeAgents() {
  const projectId = useProjectScope()?.projectId
  const href = useWorkspaceHref()
  const state = useRemote(
    async (signal) =>
      listItems<ManagedAgent>(
        await buildCall(buildOperations.listAgents, {}, { signal })
      ),
    [projectId]
  )

  return (
    <section aria-labelledby="home-agents-title" className="space-y-3 p-3 pb-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="home-agents-title" className="mr-auto text-sm font-medium">
          Your agents
        </h2>
        <Button
          variant="ghost-muted"
          size="icon-sm"
          aria-label="Refresh agents"
          onClick={state.refresh}
          loading={state.isRefreshing}
        >
          <RefreshCw />
        </Button>
        <Button asChild variant="ghost-muted" size="sm">
          <Link href={href("/agents")}>View all</Link>
        </Button>
        <Button asChild size="sm">
          <Link href={href("/build/agents/new")}>
            <Plus />
            New agent
          </Link>
        </Button>
      </div>
      {state.error && (
        <Notice variant="error" role="alert" title="Could not load agents">
          {state.error.message}
          <Button variant="outline" size="sm" onClick={state.refresh}>
            Retry agents
          </Button>
        </Notice>
      )}
      {state.data === null && state.isLoading ? (
        <div
          role="status"
          aria-label="Loading agents"
          className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-3"
        >
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-48 rounded-xl" />
          ))}
        </div>
      ) : state.data?.length === 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border p-5">
          <Bot className="size-6 text-foreground-muted" />
          <div>
            <h3 className="text-sm font-medium">Create your first agent</h3>
            <p className="mt-1 text-xs text-foreground-muted">
              Add an agent to start helping customers on your website or
              WhatsApp.
            </p>
          </div>
        </div>
      ) : state.data ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-3">
          {state.data.map((agent) => {
            const agentHref = href(
              `/build/agents/${encodeURIComponent(agent.id)}`
            )
            return (
              <AgentCard
                key={agent.id}
                name={agent.name}
                appearance={agent.configuration.appearance}
                href={agentHref}
                subtitle={
                  <time
                    dateTime={agent.updatedAt}
                    title={formatDate(agent.updatedAt)}
                  >
                    Updated {formatRelative(agent.updatedAt)}
                  </time>
                }
                actions={
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost-muted"
                        size="icon-sm"
                        aria-label={`Actions for ${agent.name}`}
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild>
                        <Link href={agentHref}>
                          <ArrowUpRight />
                          Open agent
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href={`${agentHref}?section=settings`}>
                          <Settings />
                          Settings
                        </Link>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                }
              />
            )
          })}
        </div>
      ) : null}
    </section>
  )
}
