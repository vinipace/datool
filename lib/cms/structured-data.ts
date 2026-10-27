import type { Faq } from "@/payload-types"
import { getFAQDescription, getFAQPath, richTextToPlainText } from "./faq"
import { publicOrigin } from "@/lib/public-origin"

function absoluteURL(path: string) {
  return new URL(path, publicOrigin()).href
}

export function websiteStructuredData() {
  const origin = publicOrigin()
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${origin}/#organization`,
        name: "Datool",
        url: origin,
      },
      {
        "@type": "WebSite",
        "@id": `${origin}/#website`,
        name: "Datool",
        url: origin,
        publisher: { "@id": `${origin}/#organization` },
      },
      {
        "@type": "SoftwareApplication",
        name: "Datool",
        url: origin,
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Web",
        description:
          "Trace AI workflows, evaluate real examples, and measure quality with Datool.",
        publisher: { "@id": `${origin}/#organization` },
      },
    ],
  }
}

export function faqStructuredData(faq: Faq) {
  const url = absoluteURL(getFAQPath(faq.slug))
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": url,
    url,
    name: faq.question,
    description: getFAQDescription(faq),
    datePublished: faq.publishedAt || undefined,
    dateModified: faq.updatedAt,
    mainEntity: [
      {
        "@type": "Question",
        "@id": `${url}#question`,
        name: faq.question,
        acceptedAnswer: {
          "@type": "Answer",
          text: [faq.shortAnswer, richTextToPlainText(faq.answer)]
            .filter(Boolean)
            .join("\n\n"),
        },
      },
    ],
  }
}

export function faqIndexStructuredData(title: string, faqs: Faq[]) {
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    url: absoluteURL("/faq"),
    name: title,
    mainEntity: {
      "@type": "ItemList",
      itemListElement: faqs.map((faq, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: faq.question,
        url: absoluteURL(getFAQPath(faq.slug)),
      })),
    },
  }
}

export function serializeStructuredData(data: unknown) {
  return JSON.stringify(data).replace(/</g, "\\u003c")
}
