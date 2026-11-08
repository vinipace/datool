/**
 * Refuses a release whose credential encryption key differs from the one that
 * encrypted the stored provider, sandbox, channel and Shopify credentials.
 *
 * The key comes from DATOOL_PROVIDER_ENCRYPTION_KEY, or BETTER_AUTH_SECRET
 * when that is unset. Rotating either one, or setting the provider key after
 * data exists, would otherwise make every stored credential undecryptable.
 * Set DATOOL_ALLOW_ENCRYPTION_KEY_CHANGE=true only for an intentional change
 * after the stored credentials have been re-entered or re-encrypted.
 */
import { assertDatabaseConfiguration, db } from "../lib/db"
import {
  decryptProviderKey,
  encryptionKeyConfigured,
  encryptionKeyFingerprint,
} from "../src/server/model-providers/secrets"

const NAME = "credential-encryption"

/** Returns how many sampled ciphertexts exist and how many this key opens. */
async function probeStoredCiphertexts() {
  const samples = await db.query<{
    value: string
    project_id: string
    context: string
  }>(
    `(SELECT encrypted_api_key AS value, project_id, provider AS context
        FROM project_model_provider LIMIT 5)
     UNION ALL
     (SELECT encrypted_credentials, project_id, 'build-channel:' || id::text
        FROM build_channel_connection WHERE encrypted_credentials IS NOT NULL LIMIT 5)`
  )
  let opened = 0
  for (const row of samples.rows) {
    try {
      decryptProviderKey(row.value, row.project_id, row.context)
      opened++
    } catch {
      /* Counted below. */
    }
  }
  return { sampled: samples.rows.length, opened }
}

export async function checkEncryptionKey(
  allowChange = process.env.DATOOL_ALLOW_ENCRYPTION_KEY_CHANGE === "true"
): Promise<{ ok: boolean; message: string }> {
  if (!encryptionKeyConfigured())
    return {
      ok: true,
      message: "Credential encryption is not configured; nothing to check.",
    }
  const fingerprint = encryptionKeyFingerprint()
  const stored = await db.query<{ fingerprint: string }>(
    "SELECT fingerprint FROM secret_fingerprint WHERE name = $1",
    [NAME]
  )
  const recorded = stored.rows[0]?.fingerprint
  if (recorded === fingerprint)
    return {
      ok: true,
      message: "Credential encryption key matches the recorded key.",
    }

  if (recorded === undefined) {
    // First release with this check: prove the key against existing data.
    const probe = await probeStoredCiphertexts()
    if (probe.sampled > 0 && probe.opened === 0 && !allowChange)
      return {
        ok: false,
        message:
          "The configured credential key cannot decrypt any stored credential. DATOOL_PROVIDER_ENCRYPTION_KEY or BETTER_AUTH_SECRET differs from the key that encrypted them. Restore the previous value, or set DATOOL_ALLOW_ENCRYPTION_KEY_CHANGE=true after re-entering the credentials.",
      }
  } else if (!allowChange) {
    return {
      ok: false,
      message:
        "The credential encryption key changed since the last release. Stored provider, sandbox, channel and Shopify credentials cannot be decrypted with the new key. Restore DATOOL_PROVIDER_ENCRYPTION_KEY / BETTER_AUTH_SECRET, or set DATOOL_ALLOW_ENCRYPTION_KEY_CHANGE=true for an intentional change.",
    }
  }

  await db.query(
    `INSERT INTO secret_fingerprint(name, fingerprint) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET fingerprint = excluded.fingerprint, recorded_at = now()`,
    [NAME, fingerprint]
  )
  return {
    ok: true,
    message:
      recorded === undefined
        ? "Recorded the credential encryption key fingerprint."
        : "Credential encryption key change accepted and recorded.",
  }
}

if (import.meta.main) {
  assertDatabaseConfiguration()
  try {
    const result = await checkEncryptionKey()
    if (result.ok) console.info(result.message)
    else {
      console.error(result.message)
      process.exitCode = 1
    }
  } finally {
    await db.end()
  }
}
