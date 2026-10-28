import { parseArgs } from "node:util"
import { db } from "../lib/db"
import { createTracerDatabase } from "../src/server/tracer/db"
import { backfillKnowledgeEmbeddings } from "../src/server/build/knowledge/embeddings"

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { project: { type: "string" }, agent: { type: "string" } },
})
if (!values.project || !values.agent)
  throw new Error(
    "Usage: bun run scripts/backfill-knowledge-embeddings.ts --project <id> --agent <id>"
  )

const context = {
  projectId: values.project,
  database: createTracerDatabase(undefined, { projectId: values.project }),
}
try {
  const result = await backfillKnowledgeEmbeddings(context, {
    agentId: values.agent,
    onProgress: (embedded) => console.info(`Embedded ${embedded} chunks.`),
  })
  console.info(`Backfill complete: ${result.embedded} chunks embedded.`)
} catch {
  // Provider exceptions can include requests/credentials. Keep CLI output safe.
  console.error(
    "Knowledge backfill failed. Check project provider access and migrations, then rerun to resume."
  )
  process.exitCode = 1
} finally {
  await db.end()
}
