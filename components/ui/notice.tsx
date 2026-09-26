import type * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const noticeVariants = cva("px-3 py-3 text-sm", {
  variants: {
    variant: {
      default: "border-border bg-muted text-foreground",
      info: "border-info-border bg-info-background text-info-foreground",
      success:
        "border-success-border bg-success-background text-success-foreground",
      warning:
        "border-warning-border bg-warning-background text-warning-foreground",
      "warning-solid": "border-warning bg-warning text-warning-contrast",
      error:
        "border-destructive-border bg-destructive-background text-destructive",
    },
    layout: {
      inline: "rounded-lg border",
      banner: "w-full shrink-0 border-b px-6",
    },
  },
  defaultVariants: {
    variant: "default",
    layout: "inline",
  },
})

type NoticeProps = React.ComponentProps<"div"> &
  VariantProps<typeof noticeVariants> & {
    title?: React.ReactNode
  }

function Notice({
  className,
  variant,
  layout,
  title,
  children,
  ...props
}: NoticeProps) {
  return (
    <div
      data-slot="notice"
      data-variant={variant}
      data-layout={layout}
      className={cn(noticeVariants({ variant, layout }), className)}
      {...props}
    >
      {title ? <NoticeTitle>{title}</NoticeTitle> : null}
      {children ? <NoticeDescription>{children}</NoticeDescription> : null}
    </div>
  )
}

function NoticeTitle({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="notice-title"
      className={cn("font-medium", className)}
      {...props}
    />
  )
}

function NoticeDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="notice-description"
      className={cn("leading-5 [&:not(:first-child)]:mt-1", className)}
      {...props}
    />
  )
}

export {
  Notice,
  NoticeDescription,
  NoticeTitle,
  type NoticeProps,
}
