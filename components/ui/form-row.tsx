import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/** Compact horizontal field used alongside InspectorSection's vertical form sections. */
export function FormRow({
  label,
  htmlFor,
  description,
  descriptionId,
  controlWidth = "default",
  layout = "horizontal",
  variant = "default",
  children,
}: {
  label: string
  htmlFor?: string
  description?: string
  descriptionId?: string
  controlWidth?: "default" | "wide" | "auto"
  layout?: "horizontal" | "vertical"
  variant?: "default" | "plain"
  children: ReactNode
}) {
  const labelContent = htmlFor ? (
    <label htmlFor={htmlFor} className="shrink-0">
      {label}
    </label>
  ) : (
    <span className="shrink-0">{label}</span>
  )
  const help = description ? (
    <p id={descriptionId} className="text-xs leading-5 text-foreground-muted">
      {description}
    </p>
  ) : null
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
      {description && layout === "horizontal" ? (
        <div className="min-w-0 space-y-1">
          {labelContent}
          {help}
        </div>
      ) : (
        labelContent
      )}
      <div
        className={cn(
          "max-w-full min-w-0",
          layout === "vertical"
            ? "w-full"
            : controlWidth === "wide"
              ? "w-[19.2rem]"
              : controlWidth === "auto"
                ? "shrink-0"
                : "w-64"
        )}
      >
        {children}
        {layout === "vertical" && help ? (
          <div className="mt-2">{help}</div>
        ) : null}
      </div>
    </div>
  )
}
