import type { Faq, Page } from "@/payload-types"

export const FAQ_SKIP_RELATED_PAGES_CONTEXT = "cms.skipFAQRelatedPages"
export const getFAQPath = (slug: string) => `/faq/${encodeURIComponent(slug)}`

export type FAQRelatedPage = Pick<Page, "title" | "layout" | "_status"> & {
  href: string
}

export function pageUsesFAQ(
  page: Pick<Page, "layout">,
  faqID: number | string
) {
  return (
    page.layout?.some(
      (block) =>
        block.blockType === "faq" &&
        block.items?.some((item) => {
          const id = typeof item === "object" ? item?.id : item
          return id != null && String(id) === String(faqID)
        })
    ) ?? false
  )
}

export function getRelatedQuestions(faq: Faq, pages: FAQRelatedPage[]): Faq[] {
  const seen = new Set([faq.id])
  return pages
    .filter((page) => page._status === "published" && pageUsesFAQ(page, faq.id))
    .flatMap((page) => page.layout)
    .flatMap((block) => (block.blockType === "faq" ? block.items : []))
    .filter((item): item is Faq => {
      if (
        typeof item !== "object" ||
        item === null ||
        item._status !== "published" ||
        seen.has(item.id)
      )
        return false
      seen.add(item.id)
      return true
    })
}

export function richTextToPlainText(value: unknown): string {
  if (!value || typeof value !== "object") return ""
  if ("root" in value) return richTextToPlainText(value.root)
  if ("text" in value && typeof value.text === "string") return value.text
  if ("children" in value && Array.isArray(value.children)) {
    const separator = "type" in value && value.type === "root" ? "\n" : ""
    return value.children.map(richTextToPlainText).join(separator)
  }
  return ""
}

export function getFAQDescription(faq: Faq) {
  return faq.shortAnswer || richTextToPlainText(faq.answer).slice(0, 200)
}
