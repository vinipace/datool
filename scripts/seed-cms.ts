import nextEnv from "@next/env"
import { cmsSeedOptions } from "./cms-seed-options"
import { faqContent, landingBlocks, richText } from "../cms/seed-content"
import { productSeedPages } from "../cms/product-content"

nextEnv.loadEnvConfig(process.cwd())
const { dryRun, includeDraftExample } = cmsSeedOptions(
  process.argv.slice(2),
  process.env.PAYLOAD_DATABASE_URL || process.env.DATABASE_URL
)
if (dryRun)
  console.log("Preview only. Add --apply to create missing published content.")
const { getPayload } = await import("payload")
const { default: config } = await import("../payload.config")
const cms = await getPayload({ config })
try {
  const ids: number[] = []
  for (const [order, faq] of faqContent.entries()) {
    const existing = (
      await cms.find({
        collection: "faqs",
        where: { slug: { equals: faq.slug } },
        draft: true,
        limit: 1,
      })
    ).docs[0]
    const doc =
      existing ??
      (dryRun
        ? undefined
        : await cms.create({
            collection: "faqs",
            data: {
              ...faq,
              answer: richText(faq.answer),
              order,
              _status: "published",
            },
          }))
    if (doc) ids.push(doc.id)
    console.log(
      `${existing ? "Preserved" : dryRun ? "Would create" : "Created"} FAQ: ${faq.slug}`
    )
  }
  const landing = await cms.findGlobal({ slug: "landing-page", draft: true })
  if (!landing.id) {
    if (!dryRun)
      await cms.updateGlobal({
        slug: "landing-page",
        data: {
          title: "Understand and improve your AI",
          layout: landingBlocks(ids),
          _status: "published",
          seo: {
            description:
              "Trace AI workflows, evaluate real examples, and measure quality with Datool.",
          },
        },
      })
    console.log(`${dryRun ? "Would create" : "Created"} landing page`)
  } else console.log("Preserved landing page")
  const faqPage = await cms.findGlobal({ slug: "faq-page", draft: true })
  if (!faqPage.id) {
    if (!dryRun)
      await cms.updateGlobal({
        slug: "faq-page",
        data: {
          title: "Frequently asked questions",
          introduction:
            "A closer look at Datool, from your first trace to your next evaluation.",
          _status: "published",
        },
      })
    console.log(`${dryRun ? "Would create" : "Created"} FAQ page`)
  } else console.log("Preserved FAQ page")
  for (const slug of includeDraftExample
    ? ["how-it-works", "draft-example"]
    : ["how-it-works"]) {
    const existing = await cms.find({
      collection: "pages",
      where: { slug: { equals: slug } },
      draft: true,
      limit: 1,
    })
    if (existing.docs.length) {
      console.log(`Preserved page: ${slug}`)
      continue
    }
    if (!dryRun)
      await cms.create({
        collection: "pages",
        data: {
          slug,
          title:
            slug === "how-it-works"
              ? "How Datool works"
              : "Unpublished example",
          layout: [
            {
              blockType: "hero",
              title:
                slug === "how-it-works"
                  ? "Turn a real example into your next improvement."
                  : "This is a draft",
              description:
                "Inspect a trace, save a useful case, and evaluate the next version of your workflow.",
            },
            {
              blockType: "richContent",
              content: richText(
                "Connect your application to a project. Review its traces, add meaningful examples to a dataset, and compare evaluation results as you improve your AI."
              ),
            },
            {
              blockType: "callToAction",
              title: "Take a closer look",
              label: "Open Datool",
              href: "/sign-in",
            },
          ],
          _status: slug === "draft-example" ? "draft" : "published",
        },
      })
    console.log(`${dryRun ? "Would create" : "Created"} page: ${slug}`)
  }
  for (const page of productSeedPages) {
    const existing = await cms.find({
      collection: "pages",
      where: { slug: { equals: page.slug } },
      draft: true,
      limit: 1,
    })
    if (!existing.docs.length && !dryRun)
      await cms.create({ collection: "pages", data: page })
    console.log(
      `${existing.docs.length ? "Preserved" : dryRun ? "Would create" : "Created"} page: ${page.slug}`
    )
  }
} finally {
  await cms.destroy()
}
// Payload's development tooling can retain background handles after DB shutdown.
process.exit(0)
