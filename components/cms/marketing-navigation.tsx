"use client"

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
  { href: "/faq", label: "FAQ" },
]

export function MarketingNavigation() {
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
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
