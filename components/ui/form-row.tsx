import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/** Compact horizontal field used alongside InspectorSection's vertical form sections. */
export function FormRow({
  label,
  htmlFor,
  controlWidth = "default",
  children,
}: {
  label: string
  htmlFor?: string
  controlWidth?: "default" | "wide"
  children: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-3 text-sm">
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
          controlWidth === "wide" ? "w-[19.2rem]" : "w-64"
        )}
      >
        {children}
      </div>
    </div>
  )
}
