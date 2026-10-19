"use client"

import * as React from "react"
import {
  ArrowUpRight,
  Menu,
  MessageSquare,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Sun,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { AgentAvatar } from "@/components/ui/agent-avatar"
import { cn } from "@/lib/utils"
import { isSafeHttpUrl } from "@/src/lib/build/urls"
import type { ChatBubbleSettings } from "@/src/lib/build/chat-bubble"
import type { PublicChatThread } from "@/src/lib/build/public-chat"

type NavigationProps = {
  settings: ChatBubbleSettings
  newChatLabel: string
  disabled: boolean
  onNewChat: () => void
  theme: "light" | "dark"
  onThemeChange: () => void
  threads: PublicChatThread[]
  activeThreadId?: string
  title: string
  historyLabel: string
  historyEmpty: string
  historyError: string | null
  onSelectThread: (id: string) => void
}

function PageBrand({
  settings,
  compact = false,
}: {
  settings: ChatBubbleSettings
  compact?: boolean
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center",
        compact ? "size-8 justify-center" : "gap-2.5"
      )}
    >
      {settings.helpPage.logoUrl && isSafeHttpUrl(settings.helpPage.logoUrl) ? (
        // Customer-provided branding is served directly without server image fetching.
        <img
          src={settings.helpPage.logoUrl}
          alt={settings.displayName}
          className={cn(
            "object-contain",
            compact ? "size-8" : "max-h-9 max-w-36"
          )}
        />
      ) : (
        <>
          <AgentAvatar appearance={settings} className="size-8 rounded-lg" />
          <span
            className={compact ? "sr-only" : "truncate text-sm font-semibold"}
          >
            {settings.displayName}
          </span>
        </>
      )}
    </div>
  )
}

function ThemeButton({ settings, theme, onThemeChange }: NavigationProps) {
  if (!settings.helpPage.allowThemeSwitch) return null
  return (
    <Button
      variant="ghost-muted"
      size="icon-sm"
      aria-label={
        theme === "light" ? "Switch to dark theme" : "Switch to light theme"
      }
      onClick={onThemeChange}
    >
      {theme === "light" ? (
        <Moon className="size-4" />
      ) : (
        <Sun className="size-4" />
      )}
    </Button>
  )
}

export function HelpPageSidebar(props: NavigationProps) {
  const [open, setOpen] = React.useState(true)
  if (!props.settings.helpPage.showSidebar) return null
  const links = props.settings.helpPage.links.filter(
    (link) =>
      link.enabled !== false &&
      link.placement !== "card" &&
      link.label.trim() &&
      isSafeHttpUrl(link.url)
  )
  return (
    <aside
      aria-label="Help page navigation"
      className={cn(
        "datool-help-sidebar min-h-0 shrink-0 flex-col border-r border-border bg-muted/30 p-4",
        open ? "w-56" : "w-16 items-center px-2"
      )}
    >
      <div
        className={cn(
          "flex items-center",
          open ? "h-10 justify-between gap-2" : "flex-col gap-3"
        )}
      >
        <PageBrand settings={props.settings} compact={!open} />
        <Button
          variant="ghost-muted"
          size="icon-sm"
          aria-label={open ? "Collapse help sidebar" : "Expand help sidebar"}
          title={open ? "Collapse help sidebar" : "Expand help sidebar"}
          onClick={() => setOpen(!open)}
        >
          {open ? (
            <PanelLeftClose className="size-4" />
          ) : (
            <PanelLeftOpen className="size-4" />
          )}
        </Button>
      </div>
      <Button
        variant="ghost"
        size={open ? "default" : "icon-sm"}
        className={open ? "mt-6 justify-start gap-2" : "mt-2"}
        disabled={props.disabled}
        onClick={props.onNewChat}
        aria-label={props.newChatLabel}
        title={open ? undefined : props.newChatLabel}
      >
        <Plus className="size-4 shrink-0" />
        {open ? props.newChatLabel : null}
      </Button>
      {open && links.length ? (
        <nav
          aria-label="Sidebar buttons"
          className="mt-5 space-y-2 border-t border-border pt-5"
        >
          {links.map((link) => (
            <Button
              key={link.id}
              asChild
              variant={link.placement === "primary" ? "default" : "ghost"}
              data-help-primary={link.placement === "primary" ? "" : undefined}
              className="w-full justify-between gap-2"
            >
              <a href={link.url} target="_blank" rel="noreferrer">
                <span className="truncate">{link.label}</span>
                <ArrowUpRight className="size-3.5 shrink-0" />
              </a>
            </Button>
          ))}
        </nav>
      ) : null}
      {open ? (
        <nav
          aria-label={props.historyLabel}
          className="mt-6 min-h-0 flex-1 space-y-1 overflow-y-auto"
        >
          <p className="mb-3 px-2 text-xs font-medium text-foreground-muted">
            {props.historyLabel}
          </p>
          {props.threads.map((thread) => (
            <Button
              key={thread.id}
              variant={
                props.activeThreadId === thread.id ? "secondary" : "ghost"
              }
              className="w-full justify-start gap-2 text-left"
              disabled={props.disabled}
              aria-current={
                props.activeThreadId === thread.id ? "page" : undefined
              }
              title={thread.title}
              onClick={() => props.onSelectThread(thread.id)}
            >
              <MessageSquare className="size-3.5 shrink-0" />
              <span className="truncate">{thread.title}</span>
            </Button>
          ))}
          {props.historyError ? (
            <p role="alert" className="px-2 text-xs text-foreground-muted">
              {props.historyError}
            </p>
          ) : !props.threads.length ? (
            <p className="px-2 text-xs leading-5 text-foreground-muted">
              {props.historyEmpty}
            </p>
          ) : null}
        </nav>
      ) : (
        <Button
          variant="ghost-muted"
          size="icon-sm"
          className="mt-2"
          aria-label={props.historyLabel}
          title={props.historyLabel}
          onClick={() => setOpen(true)}
        >
          <MessageSquare className="size-4" />
        </Button>
      )}
      <div
        className={cn(
          "mt-auto flex w-full items-center gap-2 pt-6",
          open ? "justify-between" : "justify-center"
        )}
      >
        {open ? (
          <span className="truncate text-xs text-foreground-muted">
            {props.settings.helpPage.pageTitle}
          </span>
        ) : null}
        <ThemeButton {...props} />
      </div>
    </aside>
  )
}

export function HelpPageToolbar(props: NavigationProps) {
  const links = props.settings.helpPage.links.filter(
    (link) =>
      link.enabled !== false &&
      link.placement !== "card" &&
      link.label.trim() &&
      isSafeHttpUrl(link.url)
  )
  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-border px-5">
      <h2 className="min-w-0 truncate text-sm font-medium" title={props.title}>
        {props.title}
      </h2>
      <div className="flex shrink-0 items-center gap-2">
        <div
          className={
            props.settings.helpPage.showSidebar ? "datool-help-toolbar" : "flex"
          }
        >
          <ThemeButton {...props} />
        </div>
        <div
          className={
            props.settings.helpPage.showSidebar ? "datool-help-toolbar" : "flex"
          }
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost-muted"
                size="icon-sm"
                aria-label={props.historyLabel}
              >
                <Menu className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {props.threads.map((thread) => (
                <DropdownMenuItem
                  key={thread.id}
                  disabled={props.disabled}
                  onSelect={() => props.onSelectThread(thread.id)}
                  className="max-w-72"
                >
                  <MessageSquare className="size-3.5" />
                  <span className="truncate">{thread.title}</span>
                </DropdownMenuItem>
              ))}
              {!props.threads.length ? (
                <p className="max-w-56 px-2 py-2 text-xs text-foreground-muted">
                  {props.historyEmpty}
                </p>
              ) : null}
              {links.map((link) => (
                <DropdownMenuItem key={link.id} asChild>
                  <a href={link.url} target="_blank" rel="noreferrer">
                    {link.label}
                    <ArrowUpRight className="size-3.5" />
                  </a>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={props.disabled}
          onClick={props.onNewChat}
        >
          <Plus className="size-4" />
          {props.newChatLabel}
        </Button>
      </div>
    </header>
  )
}

export function HelpPageWelcome({
  settings,
}: {
  settings: ChatBubbleSettings
}) {
  return (
    <div className="mb-8 flex flex-col items-center gap-5 text-center">
      {settings.helpPage.heroImageUrl &&
      isSafeHttpUrl(settings.helpPage.heroImageUrl) ? (
        <img
          src={settings.helpPage.heroImageUrl}
          alt=""
          className="h-16 max-w-48 object-contain"
        />
      ) : (
        <AgentAvatar appearance={settings} className="size-16 rounded-2xl" />
      )}
      <h1 className="max-w-xl text-2xl leading-tight font-semibold tracking-tight @min-[800px]/help:text-3xl">
        {settings.welcomeMessage || settings.helpPage.pageTitle}
      </h1>
      {settings.helpPage.description ? (
        <p className="max-w-lg text-sm leading-6 text-foreground-muted">
          {settings.helpPage.description}
        </p>
      ) : null}
    </div>
  )
}

export function HelpPageLinks({ settings }: { settings: ChatBubbleSettings }) {
  const links = settings.helpPage.links.filter(
    (link) =>
      link.enabled !== false &&
      link.placement === "card" &&
      link.label.trim() &&
      isSafeHttpUrl(link.url)
  )
  if (!links.length) return null
  return (
    <nav
      aria-label="Helpful resources"
      className="mt-8 grid gap-3 @min-[700px]/help:grid-cols-2"
    >
      {links.map((link) => (
        <a
          key={link.id}
          href={link.url}
          target="_blank"
          rel="noreferrer"
          className="group rounded-xl border border-border bg-background p-4 transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium">{link.label}</span>
            <ArrowUpRight className="size-4 shrink-0 text-foreground-muted" />
          </div>
          {link.description ? (
            <p className="mt-2 text-sm leading-5 text-foreground-muted">
              {link.description}
            </p>
          ) : null}
        </a>
      ))}
    </nav>
  )
}
