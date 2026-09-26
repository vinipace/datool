import {
  createCipheriv,
  createDecipheriv,
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
      "Unable to unlock the provider API key. Ask a project admin to replace it in project settings."
    )
  }
}
