import { test, expect } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { Pool } from "pg"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { drizzle } from "drizzle-orm/node-postgres"
import { createIsolatedPostgres, seedTestWorkspace } from "./helpers/postgres"
import * as schema from "@/src/server/tracer/schema"
import { encryptProviderKey } from "@/src/server/model-providers/secrets"
import {
  getProjectProviderKey,
  getOrganizationProviders,
  saveOrganizationProviderKey,
} from "@/src/server/model-providers/store"
import {
  getSandboxProviderCredentials,
  updateOrganizationSandboxSettings,
  getSandboxExecutionProviders,
} from "@/src/server/sandbox/providers-store"
import {
  changeConnection,
  organizationConnections,
} from "@/src/server/providers/connections"
import {
  storageConnection,
  storageCredentials,
} from "@/src/server/build/storage/connections"
import { createDrive } from "@/src/server/build/drives"
import { rejects } from "node:assert/strict"

// Upgrade populated databases: account assignments and native-volume credentials
// must survive, while organization ownership is enforced by SQL and encryption.
test("organization migration preserves conflicting accounts and drive references, then shares rotated defaults safely", async () => {
  const target = await createIsolatedPostgres()
  const pool = new Pool({ connectionString: target.databaseUrl })
  const previous = process.env.DATOOL_PROVIDER_ENCRYPTION_KEY
  process.env.DATOOL_PROVIDER_ENCRYPTION_KEY =
    "migration-test-key-32-characters-minimum"
  try {
    const files = (await readdir("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort()
    for (const file of files.filter((f) => f < "0090"))
      await pool.query(await readFile(`migrations/${file}`, "utf8"))
    await seedTestWorkspace(target)
    await pool.query(
      "INSERT INTO project(id,organization_id,name,slug) VALUES('second',$1,'Second','second'),('new',$1,'New','new')",
      [target.organizationId]
    )
    await pool.query(
      "INSERT INTO organization(id,name,slug,\"createdAt\") VALUES('foreign','Foreign','foreign',now())"
    )
    await pool.query(
      "INSERT INTO project(id,organization_id,name,slug) VALUES('foreign','foreign','Foreign','foreign')"
    )
    for (const [id, key] of [
      [target.projectId, "first-key"],
      ["second", "second-key"],
    ]) {
      await pool.query(
        "INSERT INTO project_model_provider(project_id,provider,encrypted_api_key) VALUES($1,'openai',$2)",
        [id, encryptProviderKey(key, id, "openai")]
      )
      await pool.query(
        "INSERT INTO project_sandbox_settings(project_id,providers,default_provider) VALUES($1,$2::jsonb,'modal')",
        [
          id,
          JSON.stringify({
            modal: encryptProviderKey(
              JSON.stringify({
                provider: "modal",
                tokenId: key,
                tokenSecret: "secret",
              }),
              id,
              "sandbox:modal"
            ),
          }),
        ]
      )
    }
    const storageId = crypto.randomUUID(),
      driveId = crypto.randomUUID()
    const config = {
      provider: "s3",
      bucket: "existing-bucket",
      prefix: "existing-prefix",
      region: "us-east-1",
    }
    await pool.query(
      "INSERT INTO build_storage_connections(id,project_id,name,provider,config_json,encrypted_credentials) VALUES($1,$2,'Files','s3',$3,$4)",
      [
        storageId,
        target.projectId,
        config,
        encryptProviderKey(
          JSON.stringify({
            accessKeyId: "storage-key",
            secretAccessKey: "storage-secret",
          }),
          target.projectId,
          `storage:${storageId}`
        ),
      ]
    )
    await pool.query(
      "INSERT INTO build_drives(id,project_id,name,provider,storage_connection_id) VALUES($1,$2,'Existing files','s3',$3)",
      [driveId, target.projectId, storageId]
    )
    const checkKey = (key = process.env.DATOOL_PROVIDER_ENCRYPTION_KEY!) =>
      promisify(execFile)(
        process.execPath,
        ["--no-env-file", "scripts/check-encryption-key.ts"],
        {
          env: {
            ...process.env,
            DATABASE_URL: target.databaseUrl,
            DATOOL_PROVIDER_ENCRYPTION_KEY: key,
            DATOOL_ALLOW_ENCRYPTION_KEY_CHANGE: "false",
          },
          timeout: 10000,
        }
      )
    expect((await checkKey()).stdout).toContain(
      "Recorded the credential encryption key fingerprint"
    )
    await pool.query(
      await readFile("migrations/0090_organization_providers.sql", "utf8")
    )
    await pool.query(
      "DELETE FROM secret_fingerprint WHERE name='credential-encryption'"
    )
    await rejects(
      checkKey("wrong-migration-key-at-least-32-characters"),
      /cannot decrypt any stored credential/
    )
    expect((await checkKey()).stdout).toContain(
      "Recorded the credential encryption key fingerprint"
    )

    const database = drizzle(pool, { schema }),
      context = { database, organizationId: target.organizationId }
    for (const [id, key] of [
      [target.projectId, "first-key"],
      ["second", "second-key"],
    ]) {
      expect(await getProjectProviderKey(id, "openai", database)).toBe(key)
      expect(
        await getSandboxProviderCredentials(id, "modal", database)
      ).toMatchObject({ tokenId: key })
    }
    const connections = (await getOrganizationProviders(context)).connections
    expect(connections).toHaveLength(2)
    expect(connections.map((c) => c.projects[0].id).sort()).toEqual(
      [target.projectId, "second"].sort()
    )
    const second = connections.find((c) => c.projects[0].id === "second")!
    await changeConnection(context, "model", second.connectionId, "default")
    expect(await getProjectProviderKey("new", "openai", database)).toBe(
      "second-key"
    )
    expect(
      await getProjectProviderKey(target.projectId, "openai", database)
    ).toBe("first-key")
    await saveOrganizationProviderKey(
      context,
      "openai",
      "rotated-second",
      second.connectionId
    )
    expect(await getProjectProviderKey("second", "openai", database)).toBe(
      "rotated-second"
    )
    expect(await getProjectProviderKey("new", "openai", database)).toBe(
      "rotated-second"
    )
    await rejects(
      changeConnection(
        { ...context, organizationId: "foreign" },
        "model",
        second.connectionId,
        "default"
      ),
      /unavailable/
    )
    await rejects(
      getProjectProviderKey("foreign", "openai", database),
      /Configure OpenAI/
    )
    await rejects(
      changeConnection(context, "model", second.connectionId, "remove"),
      /assigned/
    )
    const first = connections.find(
      (c) => c.projects[0].id === target.projectId
    )!
    await changeConnection(context, "model", first.connectionId, "inherit")
    expect(
      await getProjectProviderKey(target.projectId, "openai", database)
    ).toBe("rotated-second")
    const row = await storageConnection(context, storageId)
    expect(row.config_json).toEqual(config)
    expect(storageCredentials(context, row)).toEqual({
      accessKeyId: "storage-key",
      secretAccessKey: "storage-secret",
    })
    expect(
      (
        await pool.query(
          "SELECT storage_connection_id,organization_id FROM build_drives WHERE id=$1",
          [driveId]
        )
      ).rows[0]
    ).toEqual({
      storage_connection_id: storageId,
      organization_id: target.organizationId,
    })
    await createDrive(
      { database, projectId: "second" },
      { name: "Shared storage", provider: "s3", storageConnectionId: storageId }
    )
    await rejects(
      createDrive(
        { database, projectId: "foreign" },
        { name: "Denied", provider: "s3", storageConnectionId: storageId }
      ),
      /unavailable/
    )
    await rejects(
      pool.query(
        "UPDATE organization_provider_connections SET organization_id='foreign' WHERE id=$1",
        [first.connectionId]
      )
    )
    await rejects(
      pool.query(
        "UPDATE build_storage_connections SET organization_id='foreign' WHERE id=$1",
        [storageId]
      )
    )
    // Deleting the original project does not delete the organization's account.
    await pool.query("DELETE FROM project WHERE id=$1", [target.projectId])
    expect(
      storageCredentials(context, await storageConnection(context, storageId))
        .accessKeyId
    ).toBe("storage-key")
    await saveOrganizationProviderKey(
      context,
      "openai",
      "rotated-first",
      first.connectionId
    )
    await changeConnection(context, "model", first.connectionId, "default")
    expect(await getProjectProviderKey("new", "openai", database)).toBe(
      "rotated-first"
    )
    const firstModal = (await organizationConnections(context, "sandbox")).find(
      (row) =>
        row.provider === "modal" && row.legacy_project_id === target.projectId
    )!
    await changeConnection(context, "sandbox", firstModal.id, "default")
    await updateOrganizationSandboxSettings(context, {
      type: "remove",
      provider: "modal",
      connectionId: firstModal.id,
    })
    expect((await getSandboxExecutionProviders("second", database))[0].id).toBe(
      "modal"
    )
    await updateOrganizationSandboxSettings(context, {
      type: "default",
      provider: "local",
    })
    expect((await getSandboxExecutionProviders("second", database))[0].id).toBe(
      "local"
    )
  } finally {
    if (previous === undefined)
      delete process.env.DATOOL_PROVIDER_ENCRYPTION_KEY
    else process.env.DATOOL_PROVIDER_ENCRYPTION_KEY = previous
    await pool.end()
    await target.close()
  }
}, 30000)
