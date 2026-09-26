import { parseArgs } from "node:util"
import { assertLocalCMSDatabase } from "./cms-local-database"

export function cmsSeedOptions(args: string[], connectionString?: string) {
  const { values } = parseArgs({
    args,
    options: { database: { type: "string" }, apply: { type: "boolean" } },
  })
  if (values.database === undefined) {
    if (values.apply) throw new Error("--apply requires --database <name>.")
    assertLocalCMSDatabase(connectionString)
    return { dryRun: false, includeDraftExample: true }
  }
  let database: URL
  try {
    database = new URL(connectionString ?? "")
  } catch {
    throw new Error("Set PAYLOAD_DATABASE_URL or DATABASE_URL before seeding.")
  }
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    !values.database ||
    decodeURIComponent(database.pathname.slice(1)) !== values.database
  ) {
    throw new Error(
      "--database must match the configured Postgres database name."
    )
  }
  return { dryRun: !values.apply, includeDraftExample: false }
}
