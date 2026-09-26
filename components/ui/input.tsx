import * as React from "react"

import { cn } from "@/lib/utils"

type InputProps = React.ComponentPropsWithoutRef<"input"> & {
  variant?: "default" | "title" | "title-sm"
  invalid?: boolean
  icon?: React.ReactNode
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      className,
      variant = "default",
      invalid,
      icon,
      "aria-invalid": ariaInvalid,
      ...props
    },
    ref
  ) => {
    const control = (
      <input
        ref={ref}
        data-slot="input"
        aria-invalid={invalid ? true : ariaInvalid}
        className={cn(
          "flex h-9 w-full rounded-md border border-border bg-input-background px-3 py-2 text-sm text-foreground transition-colors outline-none placeholder:text-foreground-subtle focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/30",
          (variant === "title" || variant === "title-sm") &&
            "field-sizing-content h-auto w-auto max-w-full min-w-8 border-transparent bg-transparent px-2 py-1 text-2xl font-medium read-only:transition-none hover:border-border read-only:hover:border-transparent focus-visible:border-ring read-only:focus-visible:border-transparent read-only:focus-visible:ring-0",
          variant === "title-sm" && "px-1 text-xl",
          icon && "pl-9",
          className
        )}
        {...props}
      />
    )
    return icon ? (
      <span className="relative block">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-2.5 left-3 text-foreground-muted [&_svg]:size-4"
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

Input.displayName = "Input"

export { Input, type InputProps }
