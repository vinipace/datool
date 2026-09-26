import Link from "next/link"
import type { Faq } from "@/payload-types"
import { Button } from "@/components/ui/button"
import { ContentLink } from "@/components/ui/content-link"
import {
  getFAQPath,
  getRelatedQuestions,
  type FAQRelatedPage,
} from "@/lib/cms/faq"
import { CMSRichText } from "./page-blocks"

export function FAQLinks({ items }: { items: Faq[] }) {
  return (
    <ul className="divide-y divide-border border-y border-border">
      {items.map((faq) => (
        <li key={faq.id}>
          <ContentLink href={getFAQPath(faq.slug)}>{faq.question}</ContentLink>
        </li>
      ))}
    </ul>
  )
}

export function FAQAnswer({
  faq,
  relatedPages = [],
}: {
  faq: Faq
  relatedPages?: FAQRelatedPage[]
}) {
  return (
    <article className="py-12 sm:py-20">
      <nav aria-label="Breadcrumb" className="mb-10">
        <ol className="flex flex-wrap items-center gap-2 text-sm text-foreground-muted">
          <li>
            <Button asChild variant="link" className="h-auto p-0">
              <Link href="/">Home</Link>
            </Button>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Button asChild variant="link" className="h-auto p-0">
              <Link href="/faq">FAQ</Link>
            </Button>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page">{faq.question}</li>
        </ol>
      </nav>
      <p className="mb-4 text-sm font-medium tracking-widest text-foreground-muted uppercase">
        Answer
      </p>
      <h1 className="max-w-4xl text-4xl leading-tight font-semibold tracking-tight sm:text-6xl">
        {faq.question}
      </h1>
      <div className="mt-12">
        <FAQAnswerContent faq={faq} relatedPages={relatedPages} />
      </div>
    </article>
  )
}

export function FAQAnswerContent({
  faq,
  relatedPages = [],
  inline = false,
}: {
  faq: Faq
  relatedPages?: FAQRelatedPage[]
  inline?: boolean
}) {
  const relatedQuestions = getRelatedQuestions(faq, relatedPages)
  const Heading = inline ? "h3" : "h2"
  const prefix = `faq-${faq.slug}`
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-10">
        {faq.shortAnswer && (
          <section
            className="rounded-xl border border-border bg-muted p-6 sm:p-8"
            aria-labelledby={`${prefix}-quick-answer`}
          >
            <Heading
              id={`${prefix}-quick-answer`}
              className="mb-4 text-xl font-medium"
            >
              Quick answer
            </Heading>
            <p className="text-lg leading-relaxed text-foreground-muted">
              {faq.shortAnswer}
            </p>
          </section>
        )}
        <section aria-labelledby={`${prefix}-full-answer`}>
          <Heading
            id={`${prefix}-full-answer`}
            className="mb-5 text-xl font-medium"
          >
            In detail
          </Heading>
          <CMSRichText data={faq.answer} />
        </section>
        {relatedQuestions.length > 0 && (
          <section
            aria-labelledby={`${prefix}-related-questions`}
            className="pt-4"
          >
            <Heading
              id={`${prefix}-related-questions`}
              className="mb-5 text-2xl font-medium"
            >
              Related questions
            </Heading>
            <FAQLinks items={relatedQuestions} />
          </section>
        )}
      </div>
      {relatedPages.length > 0 && (
        <aside aria-labelledby={`${prefix}-related-pages`}>
          <Heading
            id={`${prefix}-related-pages`}
            className="mb-5 text-xl font-medium"
          >
            Related pages
          </Heading>
          <ul className="divide-y divide-border border-y border-border">
            {relatedPages.map((page) => (
              <li key={page.href}>
                <ContentLink href={page.href}>{page.title}</ContentLink>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  )
}
