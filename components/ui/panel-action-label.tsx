import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

/** Keep icon actions named while reserving space for search in narrow panels. */
export function PanelActionLabel({
  className,
  collapseAt = "sm",
  ...props
}: ComponentProps<"span"> & { collapseAt?: "sm" | "md" }) {
  return (
    <span
      className={cn(
        collapseAt === "md"
          ? "@max-[768px]/collection:sr-only"
          : "@max-[640px]/collection:sr-only",
        className
      )}
      {...props}
    />
  )
}
