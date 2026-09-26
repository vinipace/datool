"use client"

import type { PropsWithChildren, ReactNode } from "react"
import { PanelLeftIcon } from "lucide-react"
import { usePathname } from "next/navigation"
import { pageTitles } from "@/lib/page-metadata"
import { workspacePrefix } from "@/lib/workspace-routing"
import { PageLayout } from "./page-layout"

const collectionTitles: Record<string, string> = {
  traces: pageTitles.traces,
  alerts: pageTitles.alerts,
  playground: pageTitles.playground,
  dashboards: pageTitles.dashboards,
  agents: pageTitles.agents,
  workflows: pageTitles.workflows,
  sessions: pageTitles.sessions,
  reviews: pageTitles.reviews,
  "human-scores": pageTitles.humanScores,
  evals: pageTitles.evals,
  scorers: pageTitles.scorers,
  prompts: pageTitles.prompts,
  datasets: pageTitles.datasets,
}

function routeTitle(routePath: string) {
  if (routePath === "/settings") return "General"
  if (routePath === "/settings/members") return pageTitles.members
  if (routePath === "/settings/ai-providers") return pageTitles.aiProviders
  if (routePath === "/settings/sandbox-providers") return pageTitles.sandboxProviders
  if (routePath === "/settings/api-keys") return pageTitles.apiKeys
  if (routePath === "/settings/mcp") return pageTitles.mcpConnections
  if (routePath === "/projects") return pageTitles.projects
  if (routePath === "/apps/new") return pageTitles.newApp
  if (routePath.startsWith("/apps/")) return pageTitles.appDetail
  if (routePath === "/prompts/new") return pageTitles.newPrompt
  if (routePath.startsWith("/prompts/")) return pageTitles.promptDetail
  if (routePath === "/alerts/new") return pageTitles.newAlert
  if (routePath.startsWith("/alerts/") && routePath.endsWith("/edit"))
    return pageTitles.editAlert
  if (routePath.startsWith("/alerts/")) return pageTitles.alertDetail
  if (routePath === "/scorers/new") return pageTitles.newScorer
  if (routePath.startsWith("/scorers/")) return pageTitles.scorerDetail
  if (routePath.startsWith("/playground/")) return pageTitles.playgroundApp
  if (routePath.startsWith("/traces/")) return pageTitles.traceDetail
  if (routePath.startsWith("/reviews/")) return pageTitles.reviewSession
  if (routePath.startsWith("/sessions/")) return pageTitles.sessionDetail
  if (routePath.startsWith("/datasets/")) return undefined
  if (routePath.startsWith("/dashboards/")) return "Dashboard"
  if (routePath.startsWith("/evals/")) return pageTitles.evalDetail
  return collectionTitles[routePath.split("/")[1]] ?? "Datool"
}

/** Route identity stays identical before and after the project shell loads. */
export function WorkspacePageLayout({
  children,
  leading,
}: PropsWithChildren<{ leading?: ReactNode }>) {
  const pathname = usePathname()
  const prefix = workspacePrefix(pathname) ?? ""
  const routePath = pathname.slice(prefix.length) || "/"
  const parent = [
    "reviews",
    "datasets",
    "dashboards",
    "scorers",
    "prompts",
    "playground",
    "alerts",
  ].find((resource) => routePath.startsWith(`/${resource}/`))
  const segments = routePath.split("/").filter(Boolean)
  const breadcrumbs = parent
    ? [{ label: collectionTitles[parent], href: `${prefix}/${parent}` }]
    : []
  if (routePath.startsWith("/apps/")) {
    breadcrumbs.push({ label: pageTitles.playground, href: `${prefix}/playground` })
  }
  if (routePath === "/settings" || routePath.startsWith("/settings/")) {
    breadcrumbs.push({
      label: pageTitles.projectSettings,
      href: `${prefix}/settings`,
    })
  }
  if (parent === "alerts" && segments.length === 3) {
    breadcrumbs.push({
      label: pageTitles.alertDetail,
      href: `${prefix}/alerts/${segments[1]}`,
    })
  }
  if (parent === "reviews" && segments.length === 3) {
    const reviewId = segments[1]
    breadcrumbs.push({
      label: /^\d+$/.test(reviewId) ? `#${reviewId}` : pageTitles.reviewSession,
      href: `${prefix}/reviews/${reviewId}`,
    })
  }

  return (
    <PageLayout
      className="h-dvh flex-none"
      title={routeTitle(routePath)}
      breadcrumbs={breadcrumbs}
      leading={
        leading ?? (
          <div
            aria-hidden="true"
            className="-ml-0.5 grid size-8 shrink-0 place-items-center text-foreground-muted"
          >
            <PanelLeftIcon className="size-4" />
          </div>
        )
      }
    >
      {children}
    </PageLayout>
  )
}
