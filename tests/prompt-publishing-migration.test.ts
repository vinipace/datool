import { expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { Pool } from "pg"
import { Effect } from "effect"
import { createIsolatedPostgres, seedTestWorkspace } from "./helpers/postgres"
import {
  createTracerDatabase,
  closeTracerDatabase,
} from "../src/server/tracer/db"
import { createPromptService } from "../src/server/tracer/prompts"
import { defaultPrompt } from "../src/lib/tracer/prompts"

test("publishing migration preserves already served prompts and their version history", async () => {
  const target = await createIsolatedPostgres()
  const pool = new Pool({ connectionString: target.databaseUrl })
  let database: ReturnType<typeof createTracerDatabase> | undefined
  try {
    for (const name of (await readdir("migrations"))
      .filter((name) => name.endsWith(".sql") && name < "0023")
      .sort())
      await pool.query(await readFile(`migrations/${name}`, "utf8"))
    await seedTestWorkspace(target)
    const config = {
      ...defaultPrompt,
      name: "Existing prompt",
      slug: "existing",
      model: "openai/gpt-4.1-mini",
      messages: [{ role: "system", content: "Published instructions" }],
    }
    const created = "2026-09-17T10:00:00Z"
    await pool.query(
      "INSERT INTO managed_prompts (id, project_id, slug, config_json, revision, created_at, updated_at) VALUES ('legacy', $1, 'existing', $2, 2, $3, $3)",
      [target.projectId, JSON.stringify(config), created]
    )
    for (const version of [1, 2])
      await pool.query(
        "INSERT INTO managed_prompt_versions (id, project_id, prompt_id, revision, config_json, created_at) VALUES ($1, $2, 'legacy', $3, $4, $5)",
        [
          `legacy_v${version}`,
          target.projectId,
          version,
          JSON.stringify({
            ...config,
            description: version === 1 ? "Original" : "",
          }),
          created,
        ]
      )
    await pool.query(
      await readFile("migrations/0023_prompt_publishing.sql", "utf8")
    )
    database = createTracerDatabase(target.databaseUrl, {
      projectId: target.projectId,
      schema: target.schema,
    })
    const service = createPromptService(database)
    expect(
      await Effect.runPromise(service.get("existing", true))
    ).toMatchObject({
      version: 2,
      publishedVersion: 2,
      hasDraft: false,
      messages: config.messages,
    })
    expect(
      await Effect.runPromise(service.get("legacy", false, 1))
    ).toMatchObject({ version: 1, description: "Original" })
    await Effect.runPromise(
      service.save(
        { ...config, description: "Next draft", expectedRevision: 2 },
        "legacy"
      )
    )
    expect(
      (await Effect.runPromise(service.get("existing", true))).description
    ).toBe("")
    expect(
      (
        await Effect.runPromise(
          service.publish("legacy", { expectedRevision: 3 })
        )
      ).publishedVersion
    ).toBe(3)
  } finally {
    if (database) await closeTracerDatabase(database)
    await pool.end()
    await target.close()
  }
}, 30000)
