import assert from "node:assert/strict"
import { test } from "node:test"
import {
  convertMarkdownToLexical,
  editorConfigFactory,
} from "@payloadcms/richtext-lexical"
import configPromise from "../payload.config"
import { createCMSMarkdownRenderer } from "../lib/cms/markdown"
import { landingBlocks, richText } from "../cms/seed-content"
import type { Faq } from "../payload-types"

const config = await configPromise
const renderer = createCMSMarkdownRenderer(config)
const field = config.collections
  .find((collection) => collection.slug === "faqs")!
  .fields.find((field) => "name" in field && field.name === "answer")!
if (field.type !== "richText") throw new Error("Expected FAQ rich text")
const editorConfig = editorConfigFactory.fromField({ field })

const faq: Faq = {
  id: 1,
  slug: "test-question",
  question: "Question?",
  shortAnswer: "Only a summary",
  answer: richText("The complete answer."),
  _status: "published",
  createdAt: "",
  updatedAt: "",
}

test("renders every page block and the full published FAQ answer", () => {
  const layout = landingBlocks([]).map((block) =>
    block.blockType === "faq"
      ? {
          ...block,
          items: [
            faq,
            {
              ...faq,
              id: 2,
              _status: "draft" as const,
              answer: richText("Private answer"),
            },
            3,
          ],
        }
      : block
  )
  const markdown = renderer.page({ title: "Landing title", layout })
  assert.ok(markdown.includes("# See what your AI is doing. Make it better."))
  assert.ok(markdown.includes("### Follow every trace"))
  assert.ok(markdown.includes("Start with the evidence you already have."))
  assert.ok(markdown.includes("### Question?\n\nThe complete answer."))
  assert.ok(markdown.includes("[Open Datool](/sign-in)"))
  assert.ok(!markdown.includes("Private answer"))
  assert.ok(!markdown.includes("Only a summary"))
  assert.ok(!markdown.includes("# Landing title"))
})

test("keeps rich-text formatting, lists, quotes and links", () => {
  const input =
    "## A heading\n\n**Bold** and *italic* with `inline code`.\n\n- First\n- Second\n\n> A quote\n\n[Example](https://example.com)"
  const data = convertMarkdownToLexical({ editorConfig, markdown: input })
  const output = renderer.richText(data)
  assert.ok(output.includes("## A heading"))
  assert.ok(output.includes("**Bold**"))
  assert.match(output, /[*_]italic[*_]/)
  assert.ok(output.includes("`inline code`"))
  assert.match(output, /[-*] First/)
  assert.ok(output.includes("> A quote"))
  assert.ok(output.includes("[Example](https://example.com)"))
})

test("resolves published internal links without exposing draft destinations", () => {
  const data = richText("")
  data.root.children = [
    {
      type: "paragraph",
      version: 1,
      children: [
        {
          type: "link",
          version: 3,
          format: "",
          indent: 0,
          direction: null,
          fields: {
            linkType: "internal",
            doc: {
              relationTo: "pages",
              value: { id: 1, slug: "how-it-works", _status: "published" },
            },
          },
          children: [
            {
              type: "text",
              version: 1,
              text: "How it works",
              format: 0,
              detail: 0,
              mode: "normal",
              style: "",
            },
          ],
        },
      ],
    },
  ]
  assert.equal(renderer.richText(data), "[How it works](/pages/how-it-works)")
  const privateData = JSON.parse(
    JSON.stringify(data).replace('"_status":"published"', '"_status":"draft"')
  )
  assert.equal(renderer.richText(privateData), "[How it works](#)")
})

test("plain page titles are escaped and links with parentheses stay valid", () => {
  const markdown = renderer.page({
    title: "A [title]",
    layout: [
      {
        blockType: "callToAction",
        title: "Next",
        label: "Read [more]",
        href: "https://example.com/a(b)",
      },
    ],
  })
  assert.ok(markdown.includes("# A \\[title\\]"))
  assert.ok(
    markdown.includes("[Read \\[more\\]](https://example.com/a%28b%29)")
  )
})

test("FAQ Markdown includes full answers and related destinations", () => {
  const other = {
    ...faq,
    id: 2,
    slug: "another-question",
    question: "Another question?",
  }
  const markdown = renderer.faqAnswer(faq, [
    {
      title: "Example",
      href: "/pages/example",
      _status: "published",
      layout: [{ blockType: "faq", title: "Questions", items: [faq, other] }],
    },
  ])
  assert.ok(
    markdown.includes("# Question?\n\nOnly a summary\n\nThe complete answer.")
  )
  assert.ok(markdown.includes("[Another question?](/faq/another-question)"))
  assert.ok(markdown.includes("[Example](/pages/example)"))
  const index = renderer.faqIndex(
    { id: 1, title: "FAQ", introduction: "Intro" },
    [faq, { ...other, _status: "draft" }]
  )
  assert.ok(index.includes("The complete answer."))
  assert.ok(!index.includes("Another question?"))
})
