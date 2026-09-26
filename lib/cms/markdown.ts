import {
  convertLexicalToMarkdown,
  editorConfigFactory,
} from "@payloadcms/richtext-lexical"
import type { SanitizedConfig } from "payload"
import type { Faq, FaqPage, Page } from "@/payload-types"
import { safeHref } from "@/cms/access"
import { getFAQPath, getRelatedQuestions, type FAQRelatedPage } from "./faq"

function text(value: string) {
  return value.replace(/[\\`*_[\]<>#]/g, "\\$&")
}
function heading(value: string, level = 2) {
  return `${"#".repeat(level)} ${text(value.replace(/[\r\n]+/g, " "))}`
}
function link(label: string, href: string) {
  if (!safeHref(href)) return text(label)
  return `[${text(label)}](${href.replace(/[()<>]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)})`
}
function document(parts: (string | null | undefined)[]) {
  return (
    parts
      .filter((part) => part?.trim())
      .join("\n\n")
      .trim() + "\n"
  )
}

export function createCMSMarkdownRenderer(config: SanitizedConfig) {
  const field = config.collections
    .find((collection) => collection.slug === "faqs")
    ?.fields.find((field) => "name" in field && field.name === "answer")
  if (!field || field.type !== "richText")
    throw new Error("The CMS FAQ rich-text editor is not configured.")
  const editorConfig = editorConfigFactory.fromField({ field })
  const richText = (data: Faq["answer"]) =>
    convertLexicalToMarkdown({ data, editorConfig })

  function faq(faq: Faq, level = 2) {
    return document([
      heading(faq.question, level),
      faq.shortAnswer ? text(faq.shortAnswer) : null,
      richText(faq.answer),
    ])
  }

  function page(page: Pick<Page, "title" | "layout">) {
    const parts = page.layout.map((block, index) => {
      switch (block.blockType) {
        case "hero":
          return document([
            block.eyebrow ? text(block.eyebrow) : null,
            heading(block.title, index === 0 ? 1 : 2),
            text(block.description),
            block.actions
              ?.map((action) => link(action.label, action.href))
              .join("\n\n"),
          ])
        case "features":
          return document([
            heading(block.title),
            ...block.items.map((item) =>
              document([heading(item.title, 3), text(item.description)])
            ),
          ])
        case "richContent":
          return richText(block.content)
        case "faq":
          return document([
            heading(block.title),
            ...block.items.flatMap((item) =>
              typeof item === "object" &&
              item !== null &&
              item._status === "published"
                ? [document([heading(item.question, 3), richText(item.answer)])]
                : []
            ),
          ])
        case "callToAction":
          return document([
            heading(block.title),
            block.description ? text(block.description) : null,
            link(block.label, block.href),
          ])
        default: {
          const unsupported: never = block
          throw new Error(
            `Unsupported CMS block: ${JSON.stringify(unsupported)}`
          )
        }
      }
    })
    return document([
      page.layout[0]?.blockType === "hero" ? null : heading(page.title, 1),
      ...parts.map((part) => part.trim()),
    ])
  }

  function faqIndex(page: FaqPage, faqs: Faq[]) {
    return document([
      heading(page.title, 1),
      page.introduction ? text(page.introduction) : null,
      ...faqs
        .filter((item) => item._status === "published")
        .map((item) =>
          document([faq(item).trim(), link("Permalink", getFAQPath(item.slug))])
        ),
    ])
  }

  function faqAnswer(item: Faq, relatedPages: FAQRelatedPage[]) {
    const questions = getRelatedQuestions(item, relatedPages)
    return document([
      faq(item, 1).trim(),
      questions.length
        ? document([
            heading("Related questions"),
            questions
              .map((item) => `- ${link(item.question, getFAQPath(item.slug))}`)
              .join("\n"),
          ])
        : null,
      relatedPages.length
        ? document([
            heading("Related pages"),
            relatedPages
              .map((page) => `- ${link(page.title, page.href)}`)
              .join("\n"),
          ])
        : null,
    ])
  }

  return { page, faqIndex, faqAnswer, richText }
}
