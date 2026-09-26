import Link from "next/link"
import { ArrowUpRight } from "lucide-react"
import { Button } from "./button"

export function ContentLink({
  href,
  children,
  variant = "default",
  icon,
  description,
}: {
  href: string
  children: React.ReactNode
  variant?: "default" | "card"
  icon?: React.ReactNode
  description?: React.ReactNode
}) {
  if (variant === "card") {
    return (
      <Link
        href={href}
        className="flex h-full min-w-0 flex-col gap-3 rounded-xl bg-muted p-6 text-foreground transition-colors outline-none hover:bg-surface-row-hover focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="mb-2 flex items-center justify-between gap-4">
          <span className="text-foreground-muted [&_svg]:size-5">{icon}</span>
          <ArrowUpRight
            className="size-4 shrink-0 text-foreground-muted"
            aria-hidden="true"
          />
        </div>
        <div className="text-base font-medium">{children}</div>
        {description && (
          <p className="text-sm leading-relaxed text-foreground-muted">
            {description}
          </p>
        )}
      </Link>
    )
  }
  return (
    <Button
      asChild
      variant="ghost"
      className="h-auto w-full justify-between gap-6 px-3 py-5 text-left text-lg whitespace-normal"
    >
      <Link href={href}>
        <span>{children}</span>
        <ArrowUpRight aria-hidden="true" />
      </Link>
    </Button>
  )
}
