import Image from "next/image"
import Link from "next/link"
import { ArrowUpRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import datoolLogo from "@/app/icon.svg"
import { footerColumns } from "./footer-links"

/** Site-wide footer that links every public page. */
export function MarketingFooter() {
  return (
    <footer className="mt-16 border-t border-border">
      <div className="mx-auto grid max-w-6xl gap-x-8 gap-y-12 px-6 pt-14 pb-10">
        <div className="max-w-xs">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-xl font-semibold"
          >
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
          <p className="mt-4 text-sm leading-relaxed text-foreground-muted">
            Build AI agents for WhatsApp, your website and your app, and see
            every decision they make.
          </p>
          <Button asChild variant="marketing" size="sm" className="mt-6">
            <Link href="/sign-up">Get started</Link>
          </Button>
        </div>
        <nav
          aria-label="Footer"
          className="grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-3 lg:grid-cols-6"
        >
          {footerColumns.map((column) => (
            <div key={column.title}>
              <h2 className="text-sm font-medium text-foreground">
                {column.title}
              </h2>
              <ul className="mt-4 space-y-2.5 text-sm">
                {column.links.map((link) => (
                  <li key={link.href}>
                    {link.external ? (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-foreground-muted transition-colors hover:text-foreground"
                      >
                        {link.label}
                        <ArrowUpRight
                          aria-hidden="true"
                          className="ml-1 inline size-3"
                        />
                        <span className="sr-only">(opens in a new tab)</span>
                      </a>
                    ) : (
                      <Link
                        href={link.href}
                        className="text-foreground-muted transition-colors hover:text-foreground"
                      >
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>
      <div className="mx-auto max-w-6xl px-6">
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border py-6 text-sm text-foreground-muted">
          <p>
            © {new Date().getFullYear()} Datool · AI agents you can see inside.
          </p>
          <Link href="/faq" className="transition-colors hover:text-foreground">
            Questions? Start here
          </Link>
        </div>
      </div>
    </footer>
  )
}
