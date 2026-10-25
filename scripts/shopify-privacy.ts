import { parseArgs } from "node:util"
import { writeFile } from "node:fs/promises"
import { assertDatabaseConfiguration, db } from "@/lib/db"
import { decryptProviderKey } from "@/src/server/model-providers/secrets"

// Operator-only tooling. Export goes to a private file, never to console/logs.
const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    id: { type: "string" },
    output: { type: "string" },
    evidence: { type: "string" },
  },
})
const command = positionals[0]
try {
  assertDatabaseConfiguration()
  if (command === "health") {
    const result = await db.query(`SELECT count(*)::int AS pending,
      count(*) FILTER (WHERE due_at<now())::int AS overdue,
      count(*) FILTER (WHERE due_at>=now() AND due_at<=now()+interval '7 days')::int AS "dueSoon",
      min(due_at) AS "nextDueAt"
      FROM shopify_privacy_requests WHERE completed_at IS NULL`)
    const summary = result.rows[0]
    const urgent = summary.overdue > 0 || summary.dueSoon > 0
    console.log(JSON.stringify({ status: urgent ? "action_required" : "healthy", ...summary }))
    if (urgent) process.exitCode = 1
  } else if (command === "list") {
    const result =
      await db.query(`SELECT id,topic,received_at,due_at,due_at<now() AS overdue
      FROM shopify_privacy_requests WHERE completed_at IS NULL ORDER BY due_at LIMIT 100`)
    console.log(JSON.stringify(result.rows, null, 2))
  } else if (command === "export" && values.id && values.output) {
    const result = await db.query(
      `SELECT id,client_id,shop,topic,payload_encrypted FROM shopify_privacy_requests
      WHERE id=$1 AND completed_at IS NULL`,
      [values.id]
    )
    const row = result.rows[0]
    if (!row) throw new Error("Pending request not found")
    const payload = JSON.parse(
      decryptProviderKey(
        row.payload_encrypted,
        row.id,
        `shopify-privacy:${row.client_id}`
      )
    )
    await writeFile(
      values.output,
      JSON.stringify(
        { id: row.id, shop: row.shop, topic: row.topic, payload },
        null,
        2
      ),
      { mode: 0o600, flag: "wx" }
    )
    console.log(
      "Request saved to the specified private file. Fulfillment is still pending."
    )
  } else if (command === "complete" && values.id && values.evidence?.trim()) {
    // Evidence must refer to completed export/erasure, not just webhook receipt.
    if (values.evidence.length > 500)
      throw new Error("Use a short internal evidence reference")
    const result = await db.query(
      `UPDATE shopify_privacy_requests
      SET completed_at=now(),completion_reference=$2,payload_encrypted=NULL,shop=NULL
      WHERE id=$1 AND completed_at IS NULL RETURNING id`,
      [values.id, values.evidence.trim()]
    )
    if (!result.rowCount) throw new Error("Pending request not found")
    console.log("Recorded operator completion and removed the request payload.")
  } else {
    throw new Error(
      "Usage: bun scripts/shopify-privacy.ts health | list | export --id ID --output PRIVATE_FILE | complete --id ID --evidence INTERNAL_REFERENCE"
    )
  }
} catch (error) {
  if (command !== "health") throw error
  // Monitoring output must not expose database errors or connection secrets.
  console.log(JSON.stringify({ status: "unavailable" }))
  process.exitCode = 1
} finally {
  await db.end()
}
