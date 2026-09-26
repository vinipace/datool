"use client"

/**
 * A local copy of shadcn's composable Base UI sidebar pattern. Keeping it in
 * the application (rather than hiding it behind an opaque package) lets the
 * tracer own its navigation while retaining Base UI's render composition and
 * mobile drawer behavior.
 */
import * as React from "react"
import { Drawer } from "@base-ui/react/drawer"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { PanelLeftIcon } from "lucide-react"

import { cn } from "@/lib/utils"

const SIDEBAR_STORAGE_KEY = "datool_sidebar_open"
const SIDEBAR_STORAGE_EVENT = "datool:sidebar-storage"

function subscribeSidebarStorage(onChange: () => void) {
  window.addEventListener("storage", onChange)
  window.addEventListener(SIDEBAR_STORAGE_EVENT, onChange)
  return () => {
    window.removeEventListener("storage", onChange)
    window.removeEventListener(SIDEBAR_STORAGE_EVENT, onChange)
  }
}

function readSidebarStorage(): boolean | null {
  try {
    const value = window.localStorage.getItem(SIDEBAR_STORAGE_KEY)
    return value === "true" ? true : value === "false" ? false : null
  } catch {
    return null
  }
}

const SIDEBAR_WIDTH = "13.5rem"
const SIDEBAR_WIDTH_ICON = "3.375rem"
const SIDEBAR_WIDTH_MOBILE = "15.5rem"

type SidebarContextValue = {
  isMobile: boolean
  mobileWidth: string
  open: boolean
  openMobile: boolean
  setOpen: (next: boolean | ((previous: boolean) => boolean)) => void
  setOpenMobile: (next: boolean) => void
  state: "collapsed" | "expanded"
  toggleSidebar: () => void
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null)

function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState(false)

  React.useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)")
    const update = () => setIsMobile(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])

  return isMobile
}

// The hook must share the provider's module-local context.
// eslint-disable-next-line react-refresh/only-export-components
export function useSidebar() {
  const context = React.useContext(SidebarContext)
  if (!context)
    throw new Error("useSidebar must be used within a SidebarProvider.")
  return context
}

export function SidebarProvider({
  children,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  style,
}: React.PropsWithChildren<{
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  open?: boolean
  style?: React.CSSProperties & { "--sidebar-width-mobile"?: string }
}>) {
  const isMobile = useIsMobile()
  const mobileWidth = style?.["--sidebar-width-mobile"] ?? SIDEBAR_WIDTH_MOBILE
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState<boolean | null>(null)
  const storedOpen = React.useSyncExternalStore(
    subscribeSidebarStorage,
    readSidebarStorage,
    () => null
  )
  const open = controlledOpen ?? uncontrolledOpen ?? storedOpen ?? defaultOpen

  const setOpen = React.useCallback(
    (next: boolean | ((previous: boolean) => boolean)) => {
      const resolved = typeof next === "function" ? next(open) : next
      if (controlledOpen === undefined) setUncontrolledOpen(resolved)
      onOpenChange?.(resolved)
      try {
        window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(resolved))
        window.dispatchEvent(new Event(SIDEBAR_STORAGE_EVENT))
      } catch {
        // Keep the toggle working when browser storage is unavailable.
      }
    },
    [controlledOpen, onOpenChange, open]
  )


  const toggleSidebar = React.useCallback(() => {
    setOpen((current) => !current)
  }, [setOpen])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        event.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [toggleSidebar])

  const value = React.useMemo<SidebarContextValue>(
    () => ({
      isMobile,
      mobileWidth,
      open,
      openMobile: open,
      setOpen,
      setOpenMobile: setOpen,
      state: open ? "expanded" : "collapsed",
      toggleSidebar,
    }),
    [isMobile, mobileWidth, open, setOpen, toggleSidebar]
  )

  return (
    <SidebarContext.Provider value={value}>
      <div
        className="flex min-h-svh w-full"
        style={
          {
            "--sidebar-width": SIDEBAR_WIDTH,
            "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
            "--sidebar-width-mobile": SIDEBAR_WIDTH_MOBILE,
            ...style,
          } as React.CSSProperties
        }
      >
        {children}
      </div>
    </SidebarContext.Provider>
  )
}

export function Sidebar({
  children,
  className,
  collapsible = "icon",
  ...props
}: React.ComponentPropsWithoutRef<"aside"> & {
  collapsible?: "icon" | "offcanvas" | "none"
}) {
  const { isMobile, mobileWidth, openMobile, setOpenMobile, state } = useSidebar()
  const content = (
    <div className="flex size-full min-h-0 flex-col">{children}</div>
  )

  if (isMobile) {
    return (
      <Drawer.Root
        onOpenChange={setOpenMobile}
        open={openMobile}
        swipeDirection="left"
      >
        <Drawer.Portal>
          <Drawer.Backdrop className="fixed inset-0 z-50 bg-black/35 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
          <Drawer.Viewport
            className="fixed inset-y-0 left-0 z-50 max-w-full outline-none"
            // The portal does not inherit width variables from the provider.
            style={{ width: mobileWidth }}
          >
            <Drawer.Popup className="size-full border-r border-sidebar-border/50 bg-sidebar text-sidebar-foreground shadow-2xl outline-none">
              <Drawer.Content className="size-full">{content}</Drawer.Content>
            </Drawer.Popup>
          </Drawer.Viewport>
        </Drawer.Portal>
      </Drawer.Root>
    )
  }

  return (
    <aside
      data-collapsible={state === "collapsed" ? collapsible : ""}
      data-sidebar="sidebar"
      data-slot="sidebar"
      data-state={state}
      className={cn(
        "group/sidebar relative hidden min-h-svh shrink-0 flex-col border-r border-sidebar-border/50 bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-linear md:flex",
        "w-(--sidebar-width) data-[collapsible=icon]:w-(--sidebar-width-icon) md:data-[collapsible=offcanvas]:hidden",
        className
      )}
      {...props}
    >
      {content}
    </aside>
  )
}

export function SidebarInset({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"main">) {
  return (
    <main
      className={cn(
        "relative flex min-h-svh min-w-0 flex-1 flex-col bg-background",
        className
      )}
      data-slot="sidebar-inset"
      {...props}
    />
  )
}

export function SidebarHeader({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn("flex shrink-0 flex-col gap-2 p-2", className)}
      data-sidebar="header"
      data-slot="sidebar-header"
      {...props}
    />
  )
}

export function SidebarContent({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]/sidebar:overflow-hidden",
        className
      )}
      data-sidebar="content"
      data-slot="sidebar-content"
      {...props}
    />
  )
}

export function SidebarFooter({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn("flex shrink-0 flex-col gap-2 p-2", className)}
      data-sidebar="footer"
      data-slot="sidebar-footer"
      {...props}
    />
  )
}

export function SidebarGroup({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn("relative flex w-full min-w-0 flex-col p-2", className)}
      data-sidebar="group"
      data-slot="sidebar-group"
      {...props}
    />
  )
}

export function SidebarGroupLabel({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        "flex h-7 items-center px-2 text-[11px] font-medium tracking-[0.12em] text-sidebar-foreground/55 uppercase transition-all group-data-[collapsible=icon]/sidebar:-mt-7 group-data-[collapsible=icon]/sidebar:opacity-0",
        className
      )}
      data-sidebar="group-label"
      data-slot="sidebar-group-label"
      {...props}
    />
  )
}

export function SidebarMenu({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"ul">) {
  return (
    <ul
      className={cn("flex w-full min-w-0 flex-col gap-1", className)}
      data-sidebar="menu"
      data-slot="sidebar-menu"
      {...props}
    />
  )
}

export function SidebarMenuItem({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"li">) {
  return (
    <li
      className={cn("group/menu-item relative", className)}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
      {...props}
    />
  )
}

type SidebarMenuButtonProps = useRender.ComponentProps<
  "button",
  { active: boolean }
> & {
  isActive?: boolean
  size?: "default" | "lg"
}

/** Base UI's `useRender` keeps this composable with Next Link or a normal button. */
export function SidebarMenuButton({
  className,
  isActive = false,
  render,
  size = "default",
  ...props
}: SidebarMenuButtonProps) {
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(
      {
        className: cn(
          "peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md px-2 text-left text-sm text-sidebar-foreground transition-colors outline-none group-data-[collapsible=icon]/sidebar:size-9 group-data-[collapsible=icon]/sidebar:justify-center group-data-[collapsible=icon]/sidebar:px-0 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0",
          size === "default" ? "h-9" : "h-11",
          isActive && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
          className
        ),
      },
      props
    ),
    render,
    state: { active: isActive },
  })
}

export function SidebarMenuBadge({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[11px] text-sidebar-foreground/50 tabular-nums group-data-[collapsible=icon]/sidebar:hidden",
        className
      )}
      data-sidebar="menu-badge"
      data-slot="sidebar-menu-badge"
      {...props}
    />
  )
}

export function SidebarMenuAction({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"button">) {
  return (
    <button
      className={cn(
        "absolute top-1/2 right-1 grid size-7 -translate-y-1/2 place-items-center rounded-md text-sidebar-foreground/55 opacity-0 outline-none group-hover/menu-item:opacity-100 group-data-[collapsible=icon]/sidebar:hidden hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100",
        className
      )}
      data-sidebar="menu-action"
      data-slot="sidebar-menu-action"
      type="button"
      {...props}
    />
  )
}

export function SidebarTrigger({
  className,
  onClick,
  ...props
}: React.ComponentPropsWithoutRef<"button">) {
  const { open, toggleSidebar } = useSidebar()
  return (
    <button
      aria-label="Toggle sidebar"
      aria-expanded={open}
      className={cn(
        "grid size-8 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      onClick={(event) => {
        onClick?.(event)
        toggleSidebar()
      }}
      type="button"
      {...props}
    >
      <PanelLeftIcon className="size-4" />
    </button>
  )
}

export function SidebarRail({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"button">) {
  const { toggleSidebar } = useSidebar()
  return (
    <button
      aria-label="Toggle sidebar"
      className={cn(
        "absolute inset-y-0 -right-3 z-20 hidden w-4 cursor-col-resize md:block",
        className
      )}
      data-sidebar="rail"
      data-slot="sidebar-rail"
      onClick={toggleSidebar}
      tabIndex={-1}
      type="button"
      {...props}
    />
  )
}
