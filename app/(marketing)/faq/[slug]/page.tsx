import { notFound } from "next/navigation"
import { FAQAnswer } from "@/components/cms/faq-content"
import { StructuredData } from "@/components/cms/structured-data"
import { getPublishedFAQ, getFAQRelatedPages } from "@/lib/cms/content"
import { getFAQDescription, getFAQPath } from "@/lib/cms/faq"
import { cmsMetadata } from "@/lib/cms/metadata"
import { faqStructuredData } from "@/lib/cms/structured-data"

type Props = { params: Promise<{ slug: string }> }
export const dynamic = "force-dynamic"

export async function generateMetadata({ params }: Props) {
  const faq = await getPublishedFAQ((await params).slug)
  return faq
    ? cmsMetadata(
        {
          title: faq.question,
          seo: {
            ...faq.seo,
            description: faq.seo?.description || getFAQDescription(faq),
          },
        },
        getFAQPath(faq.slug)
      )
    : {}
}

export default async function FAQQuestionPage({ params }: Props) {
  const faq = await getPublishedFAQ((await params).slug)
  if (!faq) notFound()
  const relatedPages = await getFAQRelatedPages(faq.id)
  return (
    <>
      <StructuredData data={faqStructuredData(faq)} />
      <FAQAnswer faq={faq} relatedPages={relatedPages} />
    </>
  )
}
