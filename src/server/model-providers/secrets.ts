import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto"

function encryptionKey() {
  const secret =
    process.env.DATOOL_PROVIDER_ENCRYPTION_KEY || process.env.BETTER_AUTH_SECRET
  if (!secret || secret.length < 32)
    throw new Error(
      "Provider credential encryption is not configured on the server."
    )
  return Buffer.from(
    hkdfSync("sha256", secret, "datool", "model-provider-credentials:v1", 32)
  )
}

/** A one-way identifier for the credential key. Stored ciphertexts carry no key
 * id, so releases compare this value to detect a changed or newly set secret. */
export function encryptionKeyFingerprint() {
  return createHmac("sha256", encryptionKey())
    .update("datool:credential-key-fingerprint:v1")
    .digest("hex")
}

export function encryptionKeyConfigured() {
  const secret =
    process.env.DATOOL_PROVIDER_ENCRYPTION_KEY || process.env.BETTER_AUTH_SECRET
  return !!secret && secret.length >= 32
}

/** Bind ciphertext to its project and provider so copied rows cannot cross tenants. */
export function encryptProviderKey(
  apiKey: string,
  projectId: string,
  provider: string
) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv)
  cipher.setAAD(Buffer.from(JSON.stringify([projectId, provider])))
  const encrypted = Buffer.concat([
    cipher.update(apiKey, "utf8"),
    cipher.final(),
  ])
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".")
}

export function decryptProviderKey(
  value: string,
  projectId: string,
  provider: string
) {
  try {
    const [version, iv, tag, encrypted, extra] = value.split(".")
    if (version !== "v1" || !iv || !tag || !encrypted || extra)
      throw new Error()
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(iv, "base64url")
    )
    decipher.setAAD(Buffer.from(JSON.stringify([projectId, provider])))
    decipher.setAuthTag(Buffer.from(tag, "base64url"))
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64url")),
      decipher.final(),
    ]).toString("utf8")
  } catch {
    throw new Error(
      "Unable to unlock the provider API key. Ask an administrator to replace it in settings."
    )
  }
}
