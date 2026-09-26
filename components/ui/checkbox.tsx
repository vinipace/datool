import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

export function Checkbox({
  className,
  ...props
}: Omit<ComponentProps<"input">, "type">) {
  return (
    <input
      {...props}
      type="checkbox"
      data-slot="checkbox"
      className={cn(
        "size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50",
        className
      )}
    />
  )
}
