import type { ComponentProps } from "react"
import { Check, Circle, Square } from "lucide-react"
import { cn } from "@/lib/utils"

/** Visible questionnaire choices with native radio/checkbox keyboard behavior. */
export function ChoiceCard({
  children,
  className,
  type = "radio",
  ...props
}: Omit<ComponentProps<"input">, "type"> & { type?: "radio" | "checkbox" }) {
  const Icon = type === "radio" ? Circle : Square
  return (
    <label className={cn("group relative block", className)}>
      <input {...props} type={type} className="peer sr-only" />
      <span className="flex min-h-10 cursor-pointer items-center gap-3 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground transition-colors peer-checked:border-selection-control peer-checked:bg-selection peer-checked:text-selection-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:pointer-events-none peer-disabled:opacity-50 hover:bg-surface-row-hover">
        <Icon
          aria-hidden="true"
          className="size-4 shrink-0 text-foreground-muted group-has-[:checked]:hidden"
        />
        <Check
          aria-hidden="true"
          className="hidden size-4 shrink-0 group-has-[:checked]:block"
        />
        <span className="min-w-0 break-words">{children}</span>
      </span>
    </label>
  )
}
