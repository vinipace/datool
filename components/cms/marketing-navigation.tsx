"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { ChevronDown, Github, Menu } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { productIcons } from "@/components/product-icons"
import { productPillars } from "@/lib/marketing/product"

function ProductLinks() {
  return productPillars.map((pillar) => {
    const Icon = productIcons[pillar.icon]
    return (
      <DropdownMenuItem
        key={pillar.slug}
        asChild
        className="items-start gap-3 p-4"
      >
        <Link href={`/product/${pillar.slug}`}>
          <Icon
            className="mt-0.5 size-5 text-marketing-primary"
            aria-hidden="true"
          />
          <span>
            <span className="block font-medium">{pillar.name}</span>
            <span className="mt-1 block text-xs leading-relaxed text-foreground-muted">
              {pillar.summary}
            </span>
          </span>
        </Link>
      </DropdownMenuItem>
    )
  })
}

const links = [
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Docs" },
]

const githubRepository = "https://github.com/vinipace/datool"

export function MarketingNavigation() {
  const [stars, setStars] = useState<number | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)

    void fetch("https://api.github.com/repos/vinipace/datool", {
      signal: controller.signal,
      credentials: "omit",
      headers: { Accept: "application/vnd.github+json" },
    })
      .then(async (response) => {
        if (!response.ok) return
        const data: { stargazers_count?: unknown } = await response.json()
        const count = data.stargazers_count
        if (
          typeof count === "number" &&
          Number.isSafeInteger(count) &&
          count >= 0
        ) {
          setStars(count)
        }
      })
      .catch(() => {
        // The repository link remains usable when GitHub is unavailable.
      })
      .finally(() => clearTimeout(timeout))

    return () => {
      clearTimeout(timeout)
      controller.abort()
    }
  }, [])

  const githubLabel = `Star Datool on GitHub${stars === null ? "" : ` (${stars.toLocaleString("en-US")} ${stars === 1 ? "star" : "stars"})`} (opens in a new tab)`
  const starCount =
    stars === null ? null : (
      <span
        className="text-xs text-foreground-muted tabular-nums"
        aria-hidden="true"
      >
        {new Intl.NumberFormat("en", {
          notation: "compact",
          maximumFractionDigits: 1,
        }).format(stars)}
      </span>
    )

  return (
    <div className="flex items-center gap-1 sm:gap-2">
      <div className="hidden items-center gap-1 md:flex">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm">
              Product <ChevronDown aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={12}
            className="w-[min(38rem,calc(100vw-2rem))] p-3"
          >
            <div className="grid grid-cols-2 gap-2">
              <ProductLinks />
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
        {links.map((link) => (
          <Button key={link.href} asChild variant="ghost" size="sm">
            <Link href={link.href}>{link.label}</Link>
          </Button>
        ))}
        <Button asChild variant="outline" size="sm">
          <a
            href={githubRepository}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={githubLabel}
          >
            <Github aria-hidden="true" />
            Star
            {starCount}
          </a>
        </Button>
      </div>
      <Button asChild variant="ghost" size="sm">
        <Link href="/sign-in">Log in</Link>
      </Button>
      <Button asChild variant="marketing" size="sm">
        <Link href="/sign-up">Sign up</Link>
      </Button>
      <div className="md:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Open navigation">
              <Menu aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={12}
            className="w-[min(24rem,calc(100vw-2rem))] p-3"
          >
            <ProductLinks />
            <DropdownMenuSeparator />
            {links.map((link) => (
              <DropdownMenuItem key={link.href} asChild>
                <Link href={link.href}>{link.label}</Link>
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem asChild>
              <a
                href={githubRepository}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={githubLabel}
              >
                <Github aria-hidden="true" />
                Star on GitHub
                {starCount}
              </a>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
