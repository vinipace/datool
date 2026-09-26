import { describe, expect, test } from "bun:test"
import type { Faq } from "../payload-types"
import { richText } from "../cms/seed-content"
import {
  getFAQPath,
  getRelatedQuestions,
  pageUsesFAQ,
  richTextToPlainText,
  type FAQRelatedPage,
} from "../lib/cms/faq"
import {
  faqStructuredData,
  serializeStructuredData,
} from "../lib/cms/structured-data"

function faq(id: number, _status: Faq["_status"] = "published"): Faq {
  return {
    id,
    _status,
    slug: `question-${id}`,
    question: `Question ${id}?`,
    answer: richText("A full answer."),
    createdAt: "",
    updatedAt: "",
  }
}
const source = faq(1)
const related = faq(2)
function page(
  items: (number | Faq)[],
  _status: FAQRelatedPage["_status"] = "published"
): FAQRelatedPage {
  return {
    title: "Page",
    href: "/pages/example",
    _status,
    layout: [{ blockType: "faq", title: "Questions", items }],
  }
}

describe("FAQ connections", () => {
  test("matches stored and populated relationships", () => {
    expect(pageUsesFAQ(page([1]), "1")).toBe(true)
    expect(pageUsesFAQ(page([source]), 1)).toBe(true)
    expect(pageUsesFAQ(page([related]), 1)).toBe(false)
  })
  test("deduplicates shared questions and excludes self, drafts, unresolved IDs and unrelated pages", () => {
    const pages = [
      page([source, related, faq(3, "draft"), 4]),
      page([source, related]),
      page([source, faq(5)], "draft"),
      page([faq(6)]),
    ]
    expect(getRelatedQuestions(source, pages).map((item) => item.id)).toEqual([
      2,
    ])
  })
  test("an isolated question has no related questions", () => {
    expect(getRelatedQuestions(source, [page([source])])).toEqual([])
  })
  test("encodes question paths", () => {
    expect(getFAQPath("a/b")).toBe("/faq/a%2Fb")
  })
})

test("FAQ structured data uses the full answer and escapes embedded HTML", () => {
  const answer = "This </script><script>alert(1)</script> is text."
  const doc = { ...source, shortAnswer: "Summary.", answer: richText(answer) }
  expect(richTextToPlainText(doc.answer)).toBe(answer)
  const data = faqStructuredData(doc)
  expect(data.mainEntity[0].acceptedAnswer.text).toBe(`Summary.\n\n${answer}`)
  const serialized = serializeStructuredData(data)
  expect(serialized).not.toContain("<")
  expect(JSON.parse(serialized)).toEqual(data)
})
