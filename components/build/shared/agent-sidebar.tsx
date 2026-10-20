"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import {
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
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

/** Keep the ordinary Agents link while its editor is loading or unavailable. */
export function AgentSidebarTarget({ children }: React.PropsWithChildren) {
  const context = React.useContext(AgentSidebarContext)
  return (
    <>
      <div ref={context?.setTarget} className="peer empty:hidden" />
      <div className="peer-[:not(:empty)]:hidden">{children}</div>
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
}: {
  name: string
  appearance?: AgentAppearance
  active: string
  onChange: (section: string) => void
  canConfigure: boolean
  agentHref?: string
}) {
  const context = React.useContext(AgentSidebarContext)
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const workspaceHref = useWorkspaceHref()
  const { isMobile, setOpenMobile } = useSidebar()
  const closeMobileNavigation = () => {
    if (isMobile) setOpenMobile(false)
  }
  if (!context?.target) return null
  return createPortal(
    <>
      <SidebarMenuButton
        className="h-7 text-xs"
        title={`Agents / ${name}`}
        onClick={closeMobileNavigation}
        render={<Link href={workspaceHref("/build/agents")} />}
      >
        <AgentAvatar appearance={appearance} className="size-5" />
        <span>Agents / {name}</span>
      </SidebarMenuButton>
      <SidebarMenuSub aria-label="Agent sections">
        {agentBuildTabs
          .filter(
            (tab) =>
              canConfigure || tab.id === "settings" || tab.id === "instructions"
          )
          .map((tab) => {
            const query = new URLSearchParams(
              agentHref ? "" : searchParams.toString()
            )
            query.set("section", tab.id)
            return (
              <SidebarMenuItem key={tab.id}>
                <SidebarMenuSubButton
                  isActive={active === tab.id}
                  aria-current={active === tab.id ? "page" : undefined}
                  title={tab.description}
                  render={
                    <a href={`${agentHref ?? pathname}?${query.toString()}`} />
                  }
                  onClick={(event) => {
                    // Preserve open-in-new-tab and copy-link behavior. Ordinary
                    // clicks use the editor's shallow navigation to retain drafts.
                    if (
                      event.button !== 0 ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    )
                      return
                    event.preventDefault()
                    onChange(tab.id)
                    closeMobileNavigation()
                  }}
                >
                  <span>{tab.label}</span>
                </SidebarMenuSubButton>
              </SidebarMenuItem>
            )
          })}
      </SidebarMenuSub>
    </>,
    context.target
  )
}
