"use client"

import type { MouseEvent, ReactNode } from "react"
import { usePathname } from "next/navigation"
import { ContentDisclosure } from "@/components/ui/content-disclosure"
import { getFAQPath } from "@/lib/cms/faq"

export function FAQAccordion({
  items,
}: {
  items: { slug: string; question: string; content: ReactNode }[]
}) {
  const pathname = usePathname()

  function openQuestion(path: string) {
    const url = new URL(window.location.href)
    url.pathname = path
    url.hash = ""
    // Next's native history integration keeps usePathname and Back/Forward in
    // sync without fetching or replacing the FAQ index's server component tree.
    window.history.pushState(null, "", url)
  }

  function followRelatedQuestion(event: MouseEvent<HTMLDivElement>) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return
    const link =
      event.target instanceof Element ? event.target.closest("a") : null
    if (
      !link ||
      link.getAttribute("role") === "button" ||
      link.target ||
      link.hasAttribute("download")
    )
      return
    const item = items.find(
      (faq) => getFAQPath(faq.slug) === link.getAttribute("href")
    )
    if (!item) return
    event.preventDefault()
    openQuestion(getFAQPath(item.slug))
    // The clicked related link becomes hidden when its answer closes. Keep
    // keyboard focus on the newly opened question instead.
    document.getElementById(`faq-${item.slug}-trigger`)?.focus()
  }

  return (
    <div
      className="divide-y divide-border border-y border-border"
      onClickCapture={followRelatedQuestion}
    >
      {items.map((item) => {
        const path = getFAQPath(item.slug)
        return (
          <ContentDisclosure
            key={item.slug}
            id={`faq-${item.slug}`}
            href={path}
            title={item.question}
            open={pathname === path}
            onToggle={() => openQuestion(pathname === path ? "/faq" : path)}
          >
            {item.content}
          </ContentDisclosure>
        )
      })}
    </div>
  )
}
