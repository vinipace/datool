import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { assertDatabaseConfiguration, db } from "../lib/db";

async function migrate() {
  assertDatabaseConfiguration();

  const directory = join(process.cwd(), "migrations");
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const client = await db.connect();
  try {
    // Serialize all migration runners, including parallel local starts.
    await client.query("SELECT pg_advisory_lock(hashtext('datool-schema-migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const file of files) {
      const applied = await client.query<{ name: string }>(
        "SELECT name FROM schema_migration WHERE name = $1",
        [file],
      );

      if (applied.rowCount) continue;

      await client.query("BEGIN");
      try {
        await client.query(await readFile(join(directory, file), "utf8"));
        await client.query("INSERT INTO schema_migration (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.info(`Applied ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('datool-schema-migrations'))");
    client.release();
  }
}

migrate()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });
