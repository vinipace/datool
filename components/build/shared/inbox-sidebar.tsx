"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { Plus, Search } from "lucide-react"
import { inboxViews, useInboxNavigation } from "./inbox-navigation"
import { Button } from "@/components/ui/button"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"

const InboxSidebarContext = React.createContext<{
  target: HTMLDivElement | null
  setTarget: React.Dispatch<React.SetStateAction<HTMLDivElement | null>>
} | null>(null)

export function InboxSidebarProvider({ children }: React.PropsWithChildren) {
  const [target, setTarget] = React.useState<HTMLDivElement | null>(null)
  const value = React.useMemo(() => ({ target, setTarget }), [target])
  return (
    <InboxSidebarContext.Provider value={value}>
      {children}
    </InboxSidebarContext.Provider>
  )
}

export function InboxSidebar() {
  const context = React.useContext(InboxSidebarContext)
  const navigation = useInboxNavigation()
  const { isMobile, setOpenMobile } = useSidebar()
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false)
  }
  return (
    <>
      <SidebarGroup>
        <div className="mb-3 flex items-center gap-2">
          <Button
            className="min-w-0 flex-1"
            onClick={() => {
              navigation.navigate({ new: "ticket", search: null })
              closeMobile()
            }}
          >
            <Plus className="size-4" />
            New Ticket
          </Button>
          <Button
            size="icon"
            variant="outline"
            className="shrink-0"
            aria-label="Search inbox"
            onClick={() => {
              navigation.navigate({
                search: String(Date.now()),
                new: null,
                ticket: null,
              })
              closeMobile()
            }}
          >
            <Search className="size-4" />
          </Button>
        </div>
        <SidebarMenu aria-label="Inbox views">
          {inboxViews.map((item) => (
            <SidebarMenuItem key={item.id}>
              <SidebarMenuButton
                isActive={navigation.view === item.id}
                aria-current={navigation.view === item.id ? "page" : undefined}
                render={
                  <a
                    href={navigation.href({
                      view: item.id,
                      status: null,
                      ticket: null,
                      new: null,
                    })}
                  />
                }
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
                  navigation.navigate({
                    view: item.id,
                    status: null,
                    ticket: null,
                    new: null,
                  })
                  closeMobile()
                }}
              >
                <item.icon />
                <span>{item.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroup>
      <SidebarGroup>
        <SidebarGroupLabel>Conversations</SidebarGroupLabel>
        <div ref={context?.setTarget} />
      </SidebarGroup>
    </>
  )
}

export function InboxConversations({ children }: React.PropsWithChildren) {
  const context = React.useContext(InboxSidebarContext)
  return context?.target ? createPortal(children, context.target) : null
}
