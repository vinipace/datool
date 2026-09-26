"use client"

import type * as React from "react"
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog"
import { Button, type ButtonProps } from "@/components/ui/button"
import { DialogFooter, DialogHeader } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

// shadcn's Base UI alert-dialog composition with Datool's shared theme and controls.
function AlertDialog(props: AlertDialogPrimitive.Root.Props) {
  return <AlertDialogPrimitive.Root {...props} />
}

function AlertDialogTrigger(props: AlertDialogPrimitive.Trigger.Props) {
  return (
    <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
  )
}

function AlertDialogContent({
  className,
  size = "default",
  ...props
}: AlertDialogPrimitive.Popup.Props & { size?: "default" | "sm" }) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop
        data-slot="alert-dialog-overlay"
        className="fixed inset-0 z-50 bg-overlay transition-opacity duration-100 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none"
      />
      <AlertDialogPrimitive.Popup
        data-slot="alert-dialog-content"
        data-size={size}
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100svh-2rem)] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-xl border border-border bg-muted p-5 text-foreground shadow-xl transition-[opacity,scale] duration-100 outline-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none",
          size === "sm" ? "max-w-sm" : "max-w-lg",
          className
        )}
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  )
}

function AlertDialogHeader(props: React.ComponentProps<"div">) {
  return <DialogHeader data-slot="alert-dialog-header" {...props} />
}

function AlertDialogFooter(props: React.ComponentProps<"div">) {
  return <DialogFooter data-slot="alert-dialog-footer" {...props} />
}

function AlertDialogTitle({
  className,
  ...props
}: AlertDialogPrimitive.Title.Props) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn("text-base font-semibold tracking-tight", className)}
      {...props}
    />
  )
}

function AlertDialogDescription({
  className,
  ...props
}: AlertDialogPrimitive.Description.Props) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn("text-sm leading-6 text-foreground-muted", className)}
      {...props}
    />
  )
}

function AlertDialogAction(props: ButtonProps) {
  return <Button data-slot="alert-dialog-action" {...props} />
}

function AlertDialogCancel({
  variant = "outline",
  size = "default",
  ...props
}: AlertDialogPrimitive.Close.Props & Pick<ButtonProps, "variant" | "size">) {
  return (
    <AlertDialogPrimitive.Close
      data-slot="alert-dialog-cancel"
      render={<Button variant={variant} size={size} />}
      {...props}
    />
  )
}

export {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
}
