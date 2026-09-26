import * as React from "react"

import { cn } from "@/lib/utils"

type TextareaProps = React.ComponentPropsWithoutRef<"textarea"> & {
  invalid?: boolean
  icon?: React.ReactNode
  variant?: "default" | "plain"
  autoSize?: boolean
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  (
    {
      className,
      invalid,
      icon,
      variant = "default",
      autoSize = false,
      "aria-invalid": ariaInvalid,
      ...props
    },
    ref
  ) => {
    const control = (
      <textarea
        ref={ref}
        data-slot="textarea"
        aria-invalid={invalid ? true : ariaInvalid}
        className={cn(
          "flex min-h-24 w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm text-foreground transition-colors outline-none placeholder:text-foreground-subtle focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/30",
          variant === "plain" &&
            "min-h-5 border-0 bg-transparent p-0 shadow-none focus-visible:ring-0",
          autoSize && "field-sizing-content resize-none",
          autoSize && props.rows === 1 && "min-h-9",
          icon && (variant === "plain" ? "pl-6" : "pl-9"),
          className
        )}
        {...props}
      />
    )
    return icon ? (
      <span className="relative block">
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute text-foreground-muted [&_svg]:size-4",
            variant === "plain" ? "top-0.5 left-0" : "top-2.5 left-3"
          )}
        >
          {icon}
        </span>
        {control}
      </span>
    ) : (
      control
    )
  }
)

Textarea.displayName = "Textarea"

export { Textarea, type TextareaProps }
