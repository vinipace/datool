import { readFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { z } from "zod"
import { db, analyticsDb } from "../lib/db"
import { executionCredits } from "../src/server/execution-credits/ledger"

// Maintainer-only recovery tool, never a public API or customer adjustment path.
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { organization: { type: "string" }, evidence: { type: "string" } },
})
const [command, operation] = positionals
try {
  if (command === "pending") {
    const result = await db.query(
      `SELECT o.id,p.organization_id,o.project_id,o.runtime,o.rate_version,o.reserved,o.provider_id,o.usage,o.created_at
      FROM execution_credit_operation o JOIN execution_credit_period p ON p.id=o.period_id
      WHERE o.state='reserved' AND ($1::text IS NULL OR p.organization_id=$1) ORDER BY o.created_at LIMIT 500`,
      [values.organization ?? null]
    )
    console.log(JSON.stringify(result.rows, null, 2))
  } else if (command === "settle" && operation && values.evidence) {
    const evidence = z
      .object({
        chargedNanoUsd: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER),
        providerId: z.string().min(1).nullable(),
        reason: z.string().min(10).max(2000),
        usage: z.record(z.string(), z.json()),
      })
      .strict()
      .parse(JSON.parse(await readFile(values.evidence, "utf8")))
    await executionCredits.settle(
      operation,
      evidence.chargedNanoUsd,
      evidence.providerId,
      {
        ...evidence.usage,
        reconciliation: {
          reason: evidence.reason,
          at: new Date().toISOString(),
        },
      }
    )
    console.log("Settled credit operation", operation)
  } else {
    throw new Error(
      "Usage: bun run scripts/execution-credits.ts pending [--organization ID] | settle OPERATION_ID --evidence verified-usage.json"
    )
  }
} finally {
  await db.end()
  await analyticsDb.end()
}
