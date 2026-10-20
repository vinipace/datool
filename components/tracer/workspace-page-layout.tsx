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
  reports: pageTitles.reports,
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

const buildTitles: Record<string, string> = {
  agents: pageTitles.buildAgents,
  inbox: pageTitles.buildInbox,
  contacts: pageTitles.buildContacts,
  campaigns: pageTitles.buildCampaigns,
  integrations: pageTitles.buildIntegrations,
  suggestions: pageTitles.buildSuggestions,
  tests: pageTitles.buildTests,
}

function routeTitle(routePath: string) {
  if (routePath === "/") return pageTitles.projectHome
  if (routePath === "/build/integrations/new") return pageTitles.newBuildChannel
  if (routePath.startsWith("/build/integrations/"))
    return pageTitles.buildChannel
  if (routePath === "/build") return pageTitles.build
  if (routePath === "/build/agents/new") return pageTitles.newBuildAgent
  if (routePath.startsWith("/build/agents/")) return pageTitles.buildAgent
  if (routePath.startsWith("/build/"))
    return buildTitles[routePath.split("/")[2]] ?? pageTitles.build
  if (routePath === "/settings") return "General"
  if (routePath === "/settings/members") return pageTitles.members
  if (routePath === "/settings/ai-providers") return pageTitles.aiProviders
  if (routePath === "/settings/sandbox-providers")
    return pageTitles.sandboxProviders
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
  if (routePath === "/reports/new") return pageTitles.newReport
  if (routePath.startsWith("/reports/"))
    return `Report #${routePath.split("/")[2]}`
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
    "reports",
    "scorers",
    "prompts",
    "playground",
    "alerts",
  ].find((resource) => routePath.startsWith(`/${resource}/`))
  const segments = routePath.split("/").filter(Boolean)
  const breadcrumbs = parent
    ? [{ label: collectionTitles[parent], href: `${prefix}/${parent}` }]
    : []
  if (routePath.startsWith("/build/")) {
    breadcrumbs.push({
      label: pageTitles.build,
      href: `${prefix}/build`,
    })
    if (segments.length > 2 && buildTitles[segments[1]]) {
      breadcrumbs.push({
        label: buildTitles[segments[1]],
        href: `${prefix}/build/${segments[1]}`,
      })
    }
  }
  if (routePath.startsWith("/apps/")) {
    breadcrumbs.push({
      label: pageTitles.playground,
      href: `${prefix}/playground`,
    })
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
