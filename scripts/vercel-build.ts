import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { getAuth } from "../lib/auth";
import { assertDatabaseConfiguration, db } from "../lib/db";

type SchemaRow = { schema: string };
type MigrationTableRow = { exists: boolean };
type MigrationRow = { name: string };

function databaseTargetFingerprint(databaseUrl: string) {
  const url = new URL(databaseUrl);
  const identity = `${url.protocol}//${url.hostname}:${url.port || "default"}${url.pathname}`;
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

async function expectedMigrations() {
  return (await readdir(join(process.cwd(), "migrations")))
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

async function logMigrationReadiness(phase: "before" | "after") {
  const schemaResult = await db.query<SchemaRow>(
    "SELECT pg_catalog.current_schema() AS schema",
  );
  const migrationTableResult = await db.query<MigrationTableRow>(
    "SELECT to_regclass('schema_migration') IS NOT NULL AS exists",
  );
  const expected = await expectedMigrations();
  const applied = migrationTableResult.rows[0]?.exists
    ? await db.query<MigrationRow>("SELECT name FROM schema_migration")
    : { rows: [] as MigrationRow[] };
  const appliedNames = new Set(applied.rows.map((row) => row.name));
  const missing = expected.filter((name) => !appliedNames.has(name));

  console.info(
    `[vercel-build] database target=${databaseTargetFingerprint(process.env.DATABASE_URL!)} schema=${schemaResult.rows[0]?.schema ?? "unknown"} migrations=${applied.rows.length}/${expected.length} missing=${missing.length}`,
  );

  if (phase === "after" && missing.length > 0) {
    throw new Error("The deployment database is not migration-ready.");
  }
}

function runBunScript(script: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["run", script], {
      env: process.env,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `The ${script} command failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`,
        ),
      );
    });
  });
}

async function prepareDeploymentDatabase() {
  assertDatabaseConfiguration();
  await logMigrationReadiness("before");
  await runBunScript("db:migrate");
  await logMigrationReadiness("after");

  // This calls Better Auth's adapter introspector only; it does not create a
  // user, organization, session, or other application record.
  const context = await getAuth().$context;
  if (typeof context.checkSchema !== "function") {
    throw new Error("Better Auth schema validation is unavailable.");
  }
  await context.checkSchema();
  console.info("[vercel-build] Better Auth schema validation passed");
}

async function main() {
  try {
    await prepareDeploymentDatabase();
  } finally {
    await db.end();
  }

  await runBunScript("build");
}

main().catch((error: unknown) => {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "unknown";
  console.error(`[vercel-build] deployment database preparation failed (${code})`);
  process.exitCode = 1;
});
