import * as React from "react"

import { cn } from "@/lib/utils"

type SelectProps = React.ComponentPropsWithoutRef<"select"> & {
  invalid?: boolean
  variant?: "default" | "borderless"
}

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      className,
      invalid,
      variant = "default",
      "aria-invalid": ariaInvalid,
      ...props
    },
    ref
  ) => (
    <select
      ref={ref}
      data-slot="select"
      aria-invalid={invalid ? true : ariaInvalid}
      className={cn(
        "flex h-9 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/30",
        variant === "borderless" && "border-0",
        className
      )}
      {...props}
    />
  )
)

Select.displayName = "Select"

export { Select, type SelectProps }
