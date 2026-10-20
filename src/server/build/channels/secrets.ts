import { decryptProviderKey, encryptProviderKey } from "@/src/server/model-providers/secrets"

/** Channel credentials use the existing AES-256-GCM implementation with an
 * AAD namespace bound to both project and connection. */
export function encryptChannelCredentials(
  credentials: Record<string, unknown>,
  projectId: string,
  connectionId: string,
) {
  return encryptProviderKey(
    JSON.stringify(credentials),
    projectId,
    `build-channel:${connectionId}`,
  )
}

export function decryptChannelCredentials(
  encrypted: string,
  projectId: string,
  connectionId: string,
) {
  const raw = decryptProviderKey(encrypted, projectId, `build-channel:${connectionId}`)
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Channel credentials are invalid.")
  return parsed as Record<string, unknown>
}
