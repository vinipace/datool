"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { ChevronDown, Menu } from "lucide-react"
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

// GitHub Octicons mark-github (MIT); see THIRD_PARTY_NOTICES.md.
function GitHubMark() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656" />
    </svg>
  )
}

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
        <Button asChild variant="ghost" size="sm">
          <a
            href={githubRepository}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={githubLabel}
          >
            <GitHubMark />
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
                <GitHubMark />
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
