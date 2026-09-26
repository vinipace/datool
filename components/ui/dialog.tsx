"use client"

import * as React from "react"
import { X } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { OverlayContainer } from "./overlay-container"
import { cn } from "@/lib/utils"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-overlay",
        className
      )}
      {...props}
    />
  )
}

type DialogContentProps = React.ComponentProps<
  typeof DialogPrimitive.Content
> & {
  showCloseButton?: boolean
  variant?: "default" | "sheet" | "sidebar"
  /** Scope an embedded, non-modal dialog to a positioned app frame. */
  container?: HTMLElement | null
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  variant = "default",
  container,
  onEscapeKeyDown,
  ...props
}: DialogContentProps) {
  const contentRef = React.useRef<HTMLDivElement>(null)
  return (
    <DialogPortal container={container}>
      {container ? (
        <div
          data-slot="dialog-overlay"
          aria-hidden="true"
          className="absolute inset-0 z-50 bg-overlay"
        />
      ) : (
        <DialogOverlay />
      )}
      <DialogPrimitive.Content
        ref={contentRef}
        data-slot="dialog-content"
        onEscapeKeyDown={(event) => {
          onEscapeKeyDown?.(event)
          // Radix handles Escape in capture, before nested Base UI popups.
          // Let the nested popup close before dismissing the dialog.
          if (event.target instanceof Element && event.target.closest(
            '[data-slot="select-content"], [data-slot="select-trigger"][aria-expanded="true"], [data-slot="combobox-content"], [data-slot="combobox-input"][aria-expanded="true"], [data-slot="combobox-trigger"][aria-expanded="true"], [data-slot="hover-card-content"], [data-slot="hover-card-trigger"][aria-expanded="true"]'
          )) event.preventDefault()
        }}
        className={cn(
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 fixed z-50 gap-4 border border-border bg-muted p-5 text-foreground shadow-xl outline-none",
          variant === "sidebar"
            ? "data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left inset-y-0 left-0 flex h-dvh w-[calc(100%-2rem)] max-w-sm flex-col overflow-hidden border-y-0 border-l-0 bg-background pb-[env(safe-area-inset-bottom)]"
            : variant === "sheet"
            ? "data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom bottom-0 left-0 flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-t-xl border-x-0 border-b-0 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
            : "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 top-1/2 left-1/2 grid max-h-[calc(100svh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl",
          container && "absolute max-h-full",
          container && variant === "sidebar" && "h-full",
          className
        )}
        {...props}
      >
        <OverlayContainer.Provider value={contentRef}>{children}</OverlayContainer.Provider>
        {showCloseButton ? (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-3 right-3 inline-flex size-8 items-center justify-center rounded-md text-foreground-muted transition-colors outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            <X aria-hidden="true" className="size-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("grid gap-1.5 text-left", className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("pr-8 text-base font-semibold tracking-tight", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-foreground-muted", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  type DialogContentProps,
}
