"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import Link from "next/link"
import {
  ChevronDown,
  ChevronRight,
  Eye,
  Wrench,
  type LucideIcon,
} from "lucide-react"
import { usePathname, useSearchParams } from "next/navigation"
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  useSidebar,
} from "@/components/ui/sidebar"
import { AgentAvatar } from "@/components/ui/agent-avatar"
import type { AgentAppearance } from "@/src/lib/build/contracts"
import { useWorkspaceHref } from "@/components/tracer/workspace-path"
import { agentBuildTabs } from "./build-tabs"

const AgentSidebarContext = React.createContext<{
  target: HTMLDivElement | null
  setTarget: React.Dispatch<React.SetStateAction<HTMLDivElement | null>>
} | null>(null)

export function AgentSidebarProvider({ children }: React.PropsWithChildren) {
  const [target, setTarget] = React.useState<HTMLDivElement | null>(null)
  const value = React.useMemo(() => ({ target, setTarget }), [target])
  return (
    <AgentSidebarContext.Provider value={value}>
      {children}
    </AgentSidebarContext.Provider>
  )
}

/** Restore project navigation when no agent editor owns the sidebar. */
export function AgentSidebarTarget({ children }: React.PropsWithChildren) {
  const context = React.useContext(AgentSidebarContext)
  return (
    <>
      <div
        ref={context?.setTarget}
        className="peer flex flex-col gap-2 empty:hidden"
      />
      <div className="flex flex-col gap-2 peer-[:not(:empty)]:hidden">
        {children}
      </div>
    </>
  )
}

/** The editor owns this content, so its name, section and drafts stay in sync. */
export function AgentSidebarNavigation({
  name,
  appearance,
  active,
  onChange,
  canConfigure,
  agentHref,
  agentId,
}: {
  name: string
  appearance?: AgentAppearance
  active: string
  onChange: (section: string) => void
  canConfigure: boolean
  agentHref?: string
  agentId?: string
}) {
  const context = React.useContext(AgentSidebarContext)
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const workspaceHref = useWorkspaceHref()
  const { isMobile, setOpenMobile } = useSidebar()
  const closeMobileNavigation = () => {
    if (isMobile) setOpenMobile(false)
  }
  const [expanded, setExpanded] = React.useState({
    Build: true,
    Activity: true,
  })
  const groupId = React.useId()
  const internalLink = (id: string, nested = false) => {
    const tab = agentBuildTabs.find((item) => item.id === id)!
    if (!canConfigure && id !== "settings" && id !== "instructions") return null
    const query = new URLSearchParams(agentHref ? "" : searchParams.toString())
    for (const key of [
      "datasetId", "item", "itemTab", "objectView", "filter", "inspector",
      "conversation", "ticket", "q", "status", "agentId", "view",
    ])
      query.delete(key)
    query.set("section", id)
    const base = agentHref ?? (agentId ? workspaceHref(`/build/agents/${encodeURIComponent(agentId)}`) : pathname)
    const href = id === "test" ? `${base}/test` : `${base}?${query.toString()}`
    return (
      <SidebarMenuItem key={id}>
        <SidebarMenuButton
          isActive={active === id}
          aria-current={active === id ? "page" : undefined}
          title={tab.description}
          render={<a href={href} />}
          onClick={(event) => {
            if (
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return
            event.preventDefault()
            onChange(id)
            closeMobileNavigation()
          }}
        >
          {!nested && <tab.icon aria-hidden />}
          <span>{tab.label}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  }
  const group = (
    label: "Build" | "Activity",
    Icon: LucideIcon,
    children: React.ReactNode
  ) => (
    <SidebarMenuItem>
      <SidebarMenuButton
        aria-expanded={expanded[label]}
        aria-controls={`${groupId}-${label}`}
        onClick={() =>
          setExpanded((current) => ({ ...current, [label]: !current[label] }))
        }
      >
        <Icon aria-hidden />
        <span>{label}</span>
        {expanded[label] ? (
          <ChevronDown aria-hidden className="ml-auto" />
        ) : (
          <ChevronRight aria-hidden className="ml-auto" />
        )}
      </SidebarMenuButton>
      <SidebarMenuSub
        id={`${groupId}-${label}`}
        hidden={!expanded[label]}
        className={!expanded[label] ? "hidden" : undefined}
      >
        {children}
      </SidebarMenuSub>
    </SidebarMenuItem>
  )
  if (!context?.target) return null
  return createPortal(
    <SidebarGroup className="gap-3">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size="lg"
            className="font-medium [&>span:last-child]:whitespace-normal"
            title={`${name} — back to agents`}
            aria-label={`${name} — back to agents`}
            onClick={closeMobileNavigation}
            render={<Link href={workspaceHref("/build/agents")} />}
          >
            <AgentAvatar appearance={appearance} className="size-8" />
            <span className="line-clamp-2">{name}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      <SidebarMenu aria-label="Agent sections">
        {internalLink("overview")}
        {group(
          "Build",
          Wrench,
          <>
            {internalLink("instructions", true)}
            {internalLink("knowledge", true)}
            {internalLink("actions", true)}
            {internalLink("widgets", true)}
            {internalLink("procedures", true)}
            {internalLink("guardrails", true)}
            {internalLink("settings", true)}
          </>
        )}
        {canConfigure &&
          agentId &&
          group(
            "Activity",
            Eye,
            <>
              {internalLink("conversations", true)}
              {internalLink("leads", true)}
              {internalLink("collected-data", true)}
            </>
          )}
        {internalLink("contacts")}
        {internalLink("playground")}
        {internalLink("test")}
        {internalLink("channels")}
        {internalLink("integrations")}
      </SidebarMenu>
    </SidebarGroup>,
    context.target
  )
}
