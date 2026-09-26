import "server-only"
import { cache } from "react"
import { getCMS } from "./client"
import { cmsEnabled } from "./config"
import { getPagePath } from "./page-path"
import {
  FAQ_SKIP_RELATED_PAGES_CONTEXT,
  pageUsesFAQ,
  type FAQRelatedPage,
} from "./faq"

export const publicRead = {
  overrideAccess: false,
  draft: false,
  user: null,
  context: { [FAQ_SKIP_RELATED_PAGES_CONTEXT]: true },
} as const
export const getPublishedPage = cache(async (slug: string) => {
  if (!cmsEnabled()) return null
  const result = await (
    await getCMS()
  ).find({
    ...publicRead,
    collection: "pages",
    depth: 2,
    limit: 1,
    where: {
      and: [{ slug: { equals: slug } }, { _status: { equals: "published" } }],
    },
  })
  return result.docs[0] ?? null
})
export const getPublishedFAQs = cache(async () =>
  cmsEnabled()
    ? (
        await (
          await getCMS()
        ).find({
          ...publicRead,
          collection: "faqs",
          where: { _status: { equals: "published" } },
          sort: ["order", "question"],
          pagination: false,
        })
      ).docs
    : []
)
export const getPublishedLanding = cache(async () => {
  if (!cmsEnabled()) return null
  const doc = await (
    await getCMS()
  ).findGlobal({ ...publicRead, slug: "landing-page", depth: 2 })
  return doc._status === "published" ? doc : null
})
export const getPublishedFAQPage = cache(async () => {
  if (!cmsEnabled()) return null
  const doc = await (
    await getCMS()
  ).findGlobal({ ...publicRead, slug: "faq-page", depth: 0 })
  return doc._status === "published" ? doc : null
})

export const getPublishedFAQ = cache(async (slug: string) => {
  if (!cmsEnabled()) return null
  const result = await (
    await getCMS()
  ).find({
    ...publicRead,
    collection: "faqs",
    depth: 2,
    limit: 1,
    where: {
      and: [{ slug: { equals: slug } }, { _status: { equals: "published" } }],
    },
  })
  return result.docs[0] ?? null
})

export const getPublishedPages = cache(async () =>
  cmsEnabled()
    ? (
        await (
          await getCMS()
        ).find({
          ...publicRead,
          collection: "pages",
          depth: 1,
          pagination: false,
          sort: "title",
          where: { _status: { equals: "published" } },
        })
      ).docs
    : []
)

export const getFAQRelatedPages = cache(
  async (faqID: number): Promise<FAQRelatedPage[]> => {
    const [pages, landing] = await Promise.all([
      getPublishedPages(),
      getPublishedLanding(),
    ])
    return [
      ...(landing ? [{ ...landing, href: "/" }] : []),
      ...pages.map((page) => ({
        ...page,
        href: getPagePath(page.slug),
      })),
    ].filter((page) => pageUsesFAQ(page, faqID))
  }
)
