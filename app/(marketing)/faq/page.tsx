import { notFound } from "next/navigation"
import { FAQAnswerContent } from "@/components/cms/faq-content"
import { FAQAccordion } from "@/components/cms/faq-accordion"
import { StructuredData } from "@/components/cms/structured-data"
import { faqIndexStructuredData } from "@/lib/cms/structured-data"
import {
  getPublishedFAQPage,
  getPublishedFAQs,
  getFAQRelatedPages,
} from "@/lib/cms/content"
import { cmsMetadata } from "@/lib/cms/metadata"

export const dynamic = "force-dynamic"
export async function generateMetadata() {
  const page = await getPublishedFAQPage()
  return page ? cmsMetadata(page, "/faq") : {}
}
export default async function FAQPage() {
  const [page, faqs] = await Promise.all([
    getPublishedFAQPage(),
    getPublishedFAQs(),
  ])
  if (!page) notFound()
  const items = await Promise.all(
    faqs.map(async (faq) => ({
      slug: faq.slug,
      question: faq.question,
      content: (
        <FAQAnswerContent
          faq={faq}
          relatedPages={await getFAQRelatedPages(faq.id)}
          inline
        />
      ),
    }))
  )
  return (
    <div className="py-16 sm:py-24">
      <StructuredData data={faqIndexStructuredData(page.title, faqs)} />
      <h1 className="text-4xl font-semibold tracking-tight sm:text-6xl">
        {page.title}
      </h1>
      {page.introduction && (
        <p className="mt-6 max-w-2xl text-lg text-foreground-muted">
          {page.introduction}
        </p>
      )}
      <div className="mt-12">
        {faqs.length ? (
          <FAQAccordion items={items} />
        ) : (
          <p className="text-foreground-muted">
            No questions have been published yet.
          </p>
        )}
      </div>
    </div>
  )
}
