import { Readable } from "node:stream"
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3"
import { JWT } from "google-auth-library"
import { Storage } from "@google-cloud/storage"
import type { StorageConfig } from "@/src/lib/build/storage"
import { publicHttpRequest } from "../http"

export const maxFileBytes = 16 * 1024 * 1024
export async function boundedBytes(
  stream: AsyncIterable<unknown>,
  limit = maxFileBytes
) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array))
      throw new Error("Invalid storage response.")
    size += chunk.byteLength
    if (size > limit)
      throw new Error("The file exceeds the storage transfer limit.")
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** Custom S3 endpoints use the same DNS-pinned public transport as integrations.
 * Only an installation operator can opt into private MinIO endpoints. */
const s3Transport = {
  async handle(
    request: {
      protocol: string
      hostname: string
      port?: number
      path: string
      query?: Record<string, string | string[] | null>
      method: string
      headers: Record<string, string>
      body?: unknown
    },
    options: { abortSignal?: AbortSignal } = {}
  ) {
    const url = new URL(
      `${request.protocol}//${request.hostname}${request.port ? `:${request.port}` : ""}${request.path}`
    )
    for (const [key, value] of Object.entries(request.query ?? {}))
      for (const part of Array.isArray(value) ? value : [value])
        url.searchParams.append(key, part ?? "")
    const body =
      request.body === undefined
        ? undefined
        : typeof request.body === "string" || request.body instanceof Uint8Array
          ? Buffer.from(request.body)
          : null
    if (body === null)
      throw new Error("Streaming S3 requests are not supported.")
    if (body && body.length > maxFileBytes)
      throw new Error("File is too large.")
    if (process.env.DATOOL_STORAGE_ALLOW_PRIVATE_ENDPOINTS !== "true") {
      if (url.protocol !== "https:")
        throw new Error("Storage endpoints must use HTTPS.")
      const response = await publicHttpRequest(url.href, {
        method: request.method,
        headers: request.headers,
        body,
        maxRequestBytes: maxFileBytes,
        maxResponseBytes: maxFileBytes,
        timeoutMs: 60_000,
        signal: options.abortSignal,
      })
      return {
        response: {
          statusCode: response.status,
          headers: Object.fromEntries(response.headers),
          body: Readable.from([response.body]),
        },
      }
    }
    const response = await fetch(url, {
      method: request.method,
      headers: request.headers,
      body,
      redirect: "manual",
      signal: AbortSignal.any([
        AbortSignal.timeout(60_000),
        ...(options.abortSignal ? [options.abortSignal] : []),
      ]),
    })
    const bytes = response.body
      ? await boundedBytes(Readable.fromWeb(response.body as never))
      : Buffer.alloc(0)
    return {
      response: {
        statusCode: response.status,
        headers: Object.fromEntries(response.headers),
        body: Readable.from([bytes]),
      },
    }
  },
}

export function objectStorage(
  config: StorageConfig,
  credentials: Record<string, string>
) {
  if (config.provider === "s3") {
    if (config.endpoint) {
      const endpoint = new URL(config.endpoint)
      if (
        !["https:", "http:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        endpoint.pathname !== "/"
      )
        throw new Error(
          "Use an HTTP(S) storage endpoint without credentials, a path or query parameters."
        )
    }
    const client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: Boolean(config.endpoint),
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        ...(credentials.sessionToken
          ? { sessionToken: credentials.sessionToken }
          : {}),
      },
      maxAttempts: 2,
      requestHandler: s3Transport,
    })
    return {
      async get(key: string) {
        const result = await client.send(
          new GetObjectCommand({ Bucket: config.bucket, Key: key })
        )
        if (!result.Body) throw new Error("Stored file is missing.")
        return boundedBytes(result.Body as AsyncIterable<Uint8Array>)
      },
      async put(key: string, bytes: Buffer) {
        if (bytes.length > maxFileBytes) throw new Error("File is too large.")
        await client.send(
          new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: bytes })
        )
      },
      async remove(key: string) {
        await client.send(
          new DeleteObjectCommand({ Bucket: config.bucket, Key: key })
        )
      },
      close() {
        client.destroy()
      },
    }
  }
  const client = new Storage({
    projectId: config.projectId,
    // STORAGE_EMULATOR_HOST is the SDK's JSON API base; uploads use the origin.
    ...(process.env.STORAGE_EMULATOR_HOST
      ? { apiEndpoint: new URL(process.env.STORAGE_EMULATOR_HOST).origin }
      : {}),
    authClient: new JWT({
      email: credentials.clientEmail,
      key: credentials.privateKey,
      scopes: ["https://www.googleapis.com/auth/devstorage.read_write"],
    }),
    retryOptions: { maxRetries: 2, totalTimeout: 60 },
  })
  const bucket = client.bucket(config.bucket)
  return {
    get(key: string) {
      return boundedBytes(bucket.file(key).createReadStream())
    },
    async put(key: string, bytes: Buffer) {
      if (bytes.length > maxFileBytes) throw new Error("File is too large.")
      await bucket
        .file(key)
        .save(bytes, { resumable: false, validation: "crc32c" })
    },
    async remove(key: string) {
      await bucket.file(key).delete({ ignoreNotFound: true })
    },
    close() {},
  }
}
