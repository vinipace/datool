import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/** Compact horizontal field used alongside InspectorSection's vertical form sections. */
export function FormRow({
  label,
  htmlFor,
  controlWidth = "default",
  layout = "horizontal",
  variant = "default",
  children,
}: {
  label: string
  htmlFor?: string
  controlWidth?: "default" | "wide"
  layout?: "horizontal" | "vertical"
  variant?: "default" | "plain"
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        "flex gap-3 text-sm",
        variant === "default" ? "border-b border-border px-3 py-3" : "gap-2",
        layout === "vertical"
          ? "min-w-0 flex-col"
          : "items-center justify-between"
      )}
    >
      {htmlFor ? (
        <label htmlFor={htmlFor} className="shrink-0">
          {label}
        </label>
      ) : (
        <span className="shrink-0">{label}</span>
      )}
      <div
        className={cn(
          "max-w-full min-w-0",
          layout === "vertical"
            ? "w-full"
            : controlWidth === "wide"
              ? "w-[19.2rem]"
              : "w-64"
        )}
      >
        {children}
      </div>
    </div>
  )
}
