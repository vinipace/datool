import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import nextEnv from "@next/env"
import { Pool } from "pg"
import { assertLocalCMSDatabase } from "../scripts/cms-local-database"
import { faqContent } from "../cms/seed-content"
import { productSeedPages } from "../cms/product-content"

nextEnv.loadEnvConfig(process.cwd())
const connectionString =
  process.env.PAYLOAD_DATABASE_URL || process.env.DATABASE_URL
assertLocalCMSDatabase(connectionString)
const databaseName = new URL(connectionString!).pathname.slice(1)
const { getPayload } = await import("payload")
const { default: config } = await import("../payload.config")
const cms = await getPayload({ config })
const pool = new Pool({ connectionString })

function seed(apply = false) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/seed-cms.ts",
      "--database",
      databaseName,
      ...(apply ? ["--apply"] : []),
    ],
    { encoding: "utf8", env: process.env }
  )
  assert.equal(result.status, 0, result.stdout + result.stderr)
}

async function snapshot() {
  const { rows } = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'payload' ORDER BY tablename"
  )
  const contents = []
  for (const { tablename } of rows) {
    const identifier = `"${tablename.replaceAll('"', '""')}"`
    const table = await pool.query(
      `SELECT row_to_json(t)::text AS content FROM payload.${identifier} t ORDER BY row_to_json(t)::text`
    )
    contents.push({ tablename, rows: table.rows })
  }
  return contents
}

try {
  // This test intentionally edits seeded content: use a new disposable database.
  assert.equal((await cms.count({ collection: "faqs" })).totalDocs, 0)
  assert.equal((await cms.count({ collection: "pages" })).totalDocs, 0)
  const empty = await snapshot()
  seed()
  assert.deepEqual(
    await snapshot(),
    empty,
    "Preview must not write any CMS rows"
  )
  seed(true)
  const faqs = await cms.find({ collection: "faqs" })
  assert.equal(faqs.totalDocs, faqContent.length)
  const pages = await cms.find({ collection: "pages", pagination: false })
  assert.deepEqual(
    pages.docs.map((page) => page.slug).sort(),
    ["how-it-works", ...productSeedPages.map((page) => page.slug)].sort()
  )
  assert.equal(
    (await cms.findGlobal({ slug: "landing-page" }))._status,
    "published"
  )
  assert.equal(
    (await cms.findGlobal({ slug: "faq-page" }))._status,
    "published"
  )
  const seeded = await snapshot()
  seed(true)
  assert.deepEqual(
    await snapshot(),
    seeded,
    "Reruns must not change IDs, dates, or versions"
  )

  await cms.update({
    collection: "faqs",
    id: faqs.docs[0].id,
    draft: true,
    data: { question: "Unpublished editorial change", _status: "draft" },
  })
  await cms.updateGlobal({
    slug: "landing-page",
    draft: true,
    data: { title: "Unpublished landing change", _status: "draft" },
  })
  const featurePage = pages.docs.find(
    (page) => page.slug === "product-observe"
  )!
  await cms.update({
    collection: "pages",
    id: featurePage.id,
    draft: true,
    data: { title: "An editor's feature draft", _status: "draft" },
  })
  const edited = await snapshot()
  seed(true)
  assert.deepEqual(
    await snapshot(),
    edited,
    "Editorial drafts must remain untouched"
  )
  console.log(
    "CMS seed integration passed: read-only preview, published starter content, no demo draft, identical reruns, preserved editorial drafts and versions."
  )
} finally {
  await cms.destroy()
  await pool.end()
}
process.exit(0)
