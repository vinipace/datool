import assert from "node:assert/strict"
import nextEnv from "@next/env"
import { assertLocalCMSDatabase } from "../scripts/cms-local-database"
import { richText } from "../cms/seed-content"
import {
  getRelatedQuestions,
  pageUsesFAQ,
  FAQ_SKIP_RELATED_PAGES_CONTEXT,
} from "../lib/cms/faq"

nextEnv.loadEnvConfig(process.cwd())
assertLocalCMSDatabase(
  process.env.PAYLOAD_DATABASE_URL || process.env.DATABASE_URL
)
const { getPayload } = await import("payload")
const { default: config } = await import("../payload.config")
const cms = await getPayload({ config })
const suffix = Date.now().toString()
const pageIDs: number[] = []
const faqIDs: number[] = []
const publicRead = { overrideAccess: false, draft: false, user: null } as const
try {
  const faq = await cms.create({
    collection: "faqs",
    data: {
      question: "Private FAQ",
      slug: `private-${suffix}`,
      answer: richText("Hidden FAQ answer"),
      _status: "draft",
    },
  })
  faqIDs.push(faq.id)
  const page = await cms.create({
    collection: "pages",
    data: {
      title: "Published version",
      slug: `published-${suffix}`,
      _status: "published",
      layout: [{ blockType: "faq", title: "Questions", items: [faq.id] }],
    },
  })
  pageIDs.push(page.id)
  const draft = await cms.create({
    collection: "pages",
    draft: true,
    data: {
      title: "Private page",
      slug: `private-${suffix}`,
      layout: [
        { blockType: "richContent", content: richText("Private content") },
      ],
      _status: "draft",
    },
  })
  pageIDs.push(draft.id)
  const publicPages = await cms.find({
    ...publicRead,
    collection: "pages",
    where: { id: { in: pageIDs } },
    depth: 2,
  })
  assert.deepEqual(
    publicPages.docs.map((doc) => doc.id),
    [page.id]
  )
  const faqBlock = publicPages.docs[0].layout[0]
  assert.equal(faqBlock.blockType, "faq")
  if (faqBlock.blockType === "faq")
    assert.ok(
      faqBlock.items.every(
        (item) =>
          typeof item !== "object" ||
          item === null ||
          item._status === "published"
      )
    )
  await cms.update({
    collection: "pages",
    id: page.id,
    draft: true,
    data: { title: "Secret draft change", _status: "draft" },
  })
  const stillPublished = await cms.findByID({
    ...publicRead,
    collection: "pages",
    id: page.id,
  })
  assert.equal(stillPublished.title, "Published version")
  assert.equal(stillPublished.publishedAt, page.publishedAt)
  const publicFAQs = await cms.find({
    ...publicRead,
    collection: "faqs",
    where: { id: { equals: faq.id } },
  })
  assert.equal(publicFAQs.docs.length, 0)
  await assert.rejects(
    cms.create({
      ...publicRead,
      collection: "pages",
      data: {
        title: "Unauthorized",
        slug: `unauthorized-${suffix}`,
        layout: [],
      },
    })
  )
  await assert.rejects(cms.findVersions({ ...publicRead, collection: "pages" }))
  await assert.rejects(
    cms.updateGlobal({
      ...publicRead,
      slug: "landing-page",
      data: { title: "Unauthorized" },
    })
  )
  await assert.rejects(
    cms.create({
      ...publicRead,
      collection: "cms-users",
      data: {
        email: "unauthorized@example.com",
        name: "Unauthorized",
        authUserId: "unauthorized",
      },
    })
  )
  const missing = await cms.find({
    ...publicRead,
    collection: "pages",
    where: { slug: { equals: `unknown-${suffix}` } },
  })
  assert.equal(missing.docs.length, 0)

  const question = await cms.create({
    collection: "faqs",
    data: {
      question: "Shared question",
      slug: `shared-${suffix}`,
      shortAnswer: "Short answer",
      answer: richText("Published answer"),
      _status: "published",
    },
  })
  faqIDs.push(question.id)
  const related = await cms.create({
    collection: "faqs",
    data: {
      question: "Related question",
      slug: `related-${suffix}`,
      answer: richText("Related answer"),
      _status: "published",
    },
  })
  faqIDs.push(related.id)
  await cms.update({
    collection: "pages",
    id: page.id,
    data: {
      _status: "published",
      seo: { noIndex: true },
      layout: [
        {
          blockType: "faq",
          title: "Questions",
          items: [question.id, related.id, faq.id],
        },
      ],
    },
  })
  await cms.update({
    collection: "pages",
    id: draft.id,
    draft: true,
    data: {
      layout: [
        { blockType: "faq", title: "Private references", items: [question.id] },
      ],
    },
  })
  const withReferences = await cms.findByID({
    ...publicRead,
    collection: "faqs",
    id: question.id,
    depth: 2,
  })
  assert.deepEqual(
    withReferences.relatedPages?.map((item) =>
      typeof item === "object" ? item.id : item
    ),
    [page.id]
  )
  const populatedPage = await cms.findByID({
    ...publicRead,
    collection: "pages",
    id: page.id,
    depth: 2,
    context: { [FAQ_SKIP_RELATED_PAGES_CONTEXT]: true },
  })
  assert.ok(pageUsesFAQ(populatedPage, question.id))
  assert.deepEqual(
    getRelatedQuestions(question, [
      { ...populatedPage, href: "/pages/example" },
    ]).map((item) => item.id),
    [related.id]
  )

  // An unpublished edit to an existing question must not change its public answer.
  await cms.update({
    collection: "faqs",
    id: question.id,
    draft: true,
    data: {
      question: "Private edited question",
      shortAnswer: "Private summary",
      _status: "draft",
    },
  })
  const publishedQuestion = await cms.findByID({
    ...publicRead,
    collection: "faqs",
    id: question.id,
  })
  assert.equal(publishedQuestion.question, "Shared question")
  assert.equal(publishedQuestion.shortAnswer, "Short answer")

  const base = process.env.CMS_TEST_URL || process.env.BETTER_AUTH_URL
  if (
    base &&
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname)
  ) {
    const response = await fetch(new URL(`/faq/${question.slug}`, base))
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.ok(body.includes(`/faq/${related.slug}`))
    assert.ok(body.includes(`/pages/${page.slug}`))
    assert.ok(!body.includes("Private summary"))
    assert.ok(!body.includes(`/pages/${draft.slug}`))
    assert.ok(!body.includes(`/faq/${faq.slug}`))
    const hidden = await fetch(new URL(`/faq/${faq.slug}`, base))
    assert.equal(hidden.status, 404)
    const markdown = await fetch(
      new URL(`/faq/${question.slug}.md?draft=true`, base)
    )
    assert.equal(markdown.status, 200)
    const markdownBody = await markdown.text()
    assert.ok(markdownBody.includes("Shared question"))
    assert.ok(markdownBody.includes(`/faq/${related.slug}`))
    assert.ok(!markdownBody.includes("Private summary"))
    assert.ok(!markdownBody.includes(`/pages/${draft.slug}`))
    const pageMarkdown = await fetch(new URL(`/pages/${page.slug}.md`, base))
    assert.equal(pageMarkdown.status, 200)
    assert.equal(pageMarkdown.headers.get("x-robots-tag"), "noindex, follow")
    const pageBody = await pageMarkdown.text()
    assert.ok(pageBody.includes("Published answer"))
    assert.ok(!pageBody.includes("Hidden FAQ answer"))
    assert.equal(
      (await fetch(new URL(`/faq/${faq.slug}.md`, base))).status,
      404
    )
    assert.equal(
      (await fetch(new URL(`/pages/${draft.slug}.md`, base))).status,
      404
    )
  }
  console.log(
    "CMS integration passed: published reads, draft isolation, reverse FAQ relationships, related questions, public detail routes, publication timestamp, unauthorized writes, version access, user bootstrap, unknown slugs."
  )
} finally {
  for (const id of pageIDs) await cms.delete({ collection: "pages", id })
  for (const id of faqIDs) await cms.delete({ collection: "faqs", id })
  await cms.destroy()
}
process.exit(0)
