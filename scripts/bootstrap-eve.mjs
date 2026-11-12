if (!process.env.WORKFLOW_POSTGRES_URL) throw new Error("WORKFLOW_POSTGRES_URL is required for Eve workflow storage.")
const { setupDatabase } = await import("@workflow/world-postgres/cli")
await setupDatabase()
