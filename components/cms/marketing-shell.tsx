import Image from "next/image"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { MarketingNavigation } from "./marketing-navigation"
import datoolLogo from "@/app/icon.svg"

export function MarketingShell({
  children,
  onboardingAccount,
}: {
  children: React.ReactNode
  onboardingAccount?: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <nav
          aria-label="Main navigation"
          className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-4"
        >
          {onboardingAccount ? (
            <span className="flex items-center gap-2 text-xl font-semibold">
              <Image
                src={datoolLogo}
                alt=""
                width={24}
                height={24}
                unoptimized
                className="size-6 shrink-0"
              />
              datool
            </span>
          ) : (
            <Button
              asChild
              variant="link"
              className="px-0 text-xl font-semibold"
            >
              <Link href="/">
                <Image
                  src={datoolLogo}
                  alt=""
                  width={24}
                  height={24}
                  unoptimized
                  className="size-6 shrink-0"
                />
                datool
              </Link>
            </Button>
          )}
          {onboardingAccount ?? <MarketingNavigation />}
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-6">{children}</main>
      {!onboardingAccount ? (
        <footer className="mt-16 border-t border-border">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-8 text-sm text-foreground-muted">
            <p>Datool · Understand and improve your AI.</p>
            <Button asChild variant="ghost-muted" size="sm">
              <Link href="/faq">Questions? Start here</Link>
            </Button>
          </div>
        </footer>
      ) : null}
    </div>
  )
}
