import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3"
import type { StorageConnectionInput } from "@/src/lib/build/storage"
const docker = promisify(execFile)
/** Independent provider protocol emulators, each with disposable container storage. */
export async function storageFixture(provider: "s3" | "gcs") {
  const name = `datool-storage-test-${crypto.randomUUID()}`
  const port = provider === "s3" ? "9090" : "4443"
  const image =
    provider === "s3" ? "adobe/s3mock:4.10.0" : "fsouza/fake-gcs-server:1.54.0"
  const args =
    provider === "s3" ? [] : ["-scheme", "http", "-backend", "memory"]
  const previous = {
    allow: process.env.DATOOL_STORAGE_ALLOW_PRIVATE_ENDPOINTS,
    gcs: process.env.STORAGE_EMULATOR_HOST,
    key: process.env.DATOOL_PROVIDER_ENCRYPTION_KEY,
  }
  try {
    await docker(
      "docker",
      ["run", "-d", "--name", name, "-p", `127.0.0.1::${port}`, image, ...args],
      { timeout: 120000 }
    )
    const mapping = await docker("docker", ["port", name, `${port}/tcp`])
    const endpoint = `http://${mapping.stdout.trim()}`
    const deadline = Date.now() + 90000
    while (true) {
      try {
        await fetch(endpoint, { signal: AbortSignal.timeout(1000) })
        break
      } catch (error) {
        if (Date.now() > deadline) throw error
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    const bucket = "drive-test-bucket"
    process.env.DATOOL_PROVIDER_ENCRYPTION_KEY =
      "drive-storage-test-encryption-key"
    process.env.DATOOL_STORAGE_ALLOW_PRIVATE_ENDPOINTS = "true"
    const credentials: Record<string, string> =
      provider === "s3"
        ? {
            accessKeyId: "fixture-access-key",
            secretAccessKey: "fixture-secret-key",
          }
        : {
            clientEmail: "fixture@example.iam.gserviceaccount.com",
            privateKey: "emulator-does-not-authenticate-test-key",
          }
    if (provider === "s3") {
      const client = new S3Client({
        endpoint,
        region: "us-east-1",
        forcePathStyle: true,
        credentials: { ...credentials } as {
          accessKeyId: string
          secretAccessKey: string
        },
      })
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }))
      } finally {
        client.destroy()
      }
    } else {
      process.env.STORAGE_EMULATOR_HOST = `${endpoint}/storage/v1`
      const response = await fetch(`${endpoint}/storage/v1/b?project=fixture`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: bucket }),
      })
      if (!response.ok) throw new Error(await response.text())
    }
    const input: StorageConnectionInput = {
      name: `${provider} test`,
      config:
        provider === "s3"
          ? {
              provider,
              bucket,
              region: "us-east-1",
              prefix: "datool",
              endpoint,
            }
          : { provider, bucket, projectId: "fixture", prefix: "datool" },
      credentials,
    }
    return { input, name, endpoint, close }
  } catch (error) {
    await close()
    throw error
  }
  async function close() {
    if (previous.allow === undefined)
      delete process.env.DATOOL_STORAGE_ALLOW_PRIVATE_ENDPOINTS
    else process.env.DATOOL_STORAGE_ALLOW_PRIVATE_ENDPOINTS = previous.allow
    if (previous.gcs === undefined) delete process.env.STORAGE_EMULATOR_HOST
    else process.env.STORAGE_EMULATOR_HOST = previous.gcs
    if (previous.key === undefined)
      delete process.env.DATOOL_PROVIDER_ENCRYPTION_KEY
    else process.env.DATOOL_PROVIDER_ENCRYPTION_KEY = previous.key
    await docker("docker", ["rm", "-f", name]).catch(() => undefined)
  }
}
