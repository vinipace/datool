import { betterAuth } from "better-auth"
import { organizationAuthOptions } from "@/src/server/auth/config"

import { assertDatabaseConfiguration, db } from "@/lib/db"

function readAuthConfiguration() {
  assertDatabaseConfiguration()

  const secret = process.env.BETTER_AUTH_SECRET
  const baseURL = process.env.BETTER_AUTH_URL

  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET is required before handling requests.")
  }

  if (secret.length < 32) {
    throw new Error(
      "BETTER_AUTH_SECRET must be at least 32 characters. Generate one with `openssl rand -base64 32`."
    )
  }

  if (!baseURL) {
    throw new Error("BETTER_AUTH_URL is required before handling requests.")
  }

  let url: URL
  try {
    url = new URL(baseURL)
  } catch {
    throw new Error("BETTER_AUTH_URL must be an absolute http(s) URL.")
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("BETTER_AUTH_URL must use http or https.")
  }

  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("BETTER_AUTH_URL must use https in production.")
  }

  return { baseURL, secret }
}

function createAuth() {
  const { baseURL, secret } = readAuthConfiguration()

  return betterAuth(organizationAuthOptions(db, { baseURL, secret }))
}

type Auth = ReturnType<typeof createAuth>

let authInstance: Auth | undefined

export function getAuth(): Auth {
  authInstance ??= createAuth()
  return authInstance
}

/**
 * A lazy, type-preserving auth export for server consumers. The proxy delays
 * environment validation and database-backed initialization until auth is used,
 * keeping static builds free of database and secret requirements.
 */
// Config loaders copy enumerable properties; expose options without eagerly
// constructing the auth instance when this module is imported during builds.
export const auth = new Proxy({
  get options() {
    return getAuth().options
  },
} as Auth, {
  get(_target, property, receiver) {
    return Reflect.get(getAuth(), property, receiver)
  },
})
