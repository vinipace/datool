import type { ReactNode } from "react"
import Image from "next/image"
import datoolLogo from "@/app/icon.svg"
import { cn } from "@/lib/utils"

/** Shared full-page framing for account, organization, and first-project setup. */
export function OnboardingShell({
  title,
  description,
  children,
  aside,
  footer,
  hideAsideOnMobile = false,
}: {
  title: string
  description?: string
  children: ReactNode
  aside: ReactNode
  footer?: ReactNode
  hideAsideOnMobile?: boolean
}) {
  return (
    <main className="grid min-h-svh bg-background text-foreground md:grid-cols-2">
      <section className="flex min-w-0 flex-col px-6 py-8 sm:px-10 lg:px-16">
        <div className="mx-auto flex w-full max-w-md items-center gap-3">
          <Image
            src={datoolLogo}
            alt=""
            width={36}
            height={36}
            unoptimized
            className="size-9 shrink-0"
          />
          <span className="text-2xl font-semibold tracking-tight">datool</span>
        </div>
        <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center py-12 md:py-16">
          <header className="mb-8 space-y-3">
            <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
            {description ? (
              <p className="text-sm leading-relaxed text-foreground-muted">
                {description}
              </p>
            ) : null}
          </header>
          {children}
        </div>
        {footer ? (
          <div className="mx-auto w-full max-w-md text-sm text-foreground-muted">
            {footer}
          </div>
        ) : null}
      </section>
      <aside
        className={cn(
          "flex min-w-0 items-center border-t border-border bg-muted px-6 py-10 sm:px-10 md:border-t-0 md:border-l lg:px-16",
          hideAsideOnMobile && "hidden md:flex"
        )}
      >
        <div className="mx-auto w-full max-w-md">{aside}</div>
      </aside>
    </main>
  )
}
