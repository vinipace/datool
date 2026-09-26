import { test, expect } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { rejects } from "node:assert/strict"
import { accessCredential, login } from "../bin/oauth"
import {
  saveLogin,
  readProfile,
  clearLogin,
  readCredential,
  type CredentialStore,
  type Credential,
  type Profile,
} from "../bin/credentials"

const profile = (): Profile => ({
  id: randomUUID(),
  origin: "https://datool.example",
  projectId: "project-a",
  organizationId: "org-a",
})
const credential = (): Credential => ({
  accessToken: "private-access",
  refreshToken: "private-refresh",
  expiresAt: 0,
  clientId: "client",
  tokenEndpoint: "https://datool.example/api/auth/oauth2/token",
})
function memoryStore(): CredentialStore {
  const values = new Map<string, string>()
  return {
    read: async (id) => values.get(id) ?? null,
    write: async (id, value) => {
      values.set(id, value)
    },
    remove: async (id) => {
      values.delete(id)
    },
  }
}

test("login stores only metadata on disk, removes credentials on logout and fails closed without a secure store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "datool-login-test-"))
  const store = memoryStore(),
    selected = profile(),
    secret = credential()
  try {
    await saveLogin(selected, secret, store, directory)
    const raw = await readFile(join(directory, "profile.json"), "utf8")
    expect(raw).not.toContain("private-")
    expect((await stat(join(directory, "profile.json"))).mode & 0o777).toBe(
      0o600
    )
    expect(await readCredential(selected, store)).toEqual(secret)
    await clearLogin(selected, store, directory)
    expect(await readProfile(directory)).toBeNull()
    expect(await store.read(selected.id)).toBeNull()
    const unavailable = {
      ...store,
      write: async () => {
        throw new Error("Keychain locked")
      },
    }
    await rejects(
      saveLogin(selected, secret, unavailable, directory),
      /Keychain locked/
    )
    expect(await readProfile(directory)).toBeNull()
    await store.write(
      selected.id,
      JSON.stringify({
        ...secret,
        tokenEndpoint: "https://attacker.example/token",
      })
    )
    await rejects(
      readCredential(selected, store),
      /Saved login is missing or invalid/
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("simultaneous commands rotate a refresh token once and reject unsafe discovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "datool-refresh-test-"))
  const store = memoryStore(),
    selected = profile()
  const original = globalThis.fetch
  try {
    await store.write(selected.id, JSON.stringify(credential()))
    let calls = 0
    globalThis.fetch = async (_url, init) => {
      calls++
      expect(new URLSearchParams(String(init?.body)).get("resource")).toBe(
        "https://datool.example/api/cli"
      )
      return Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        token_type: "Bearer",
        expires_in: 300,
      })
    }
    const results = await Promise.all([
      accessCredential(selected, store, directory),
      accessCredential(selected, store, directory),
    ])
    expect(calls).toBe(1)
    expect(results.map((item) => item.refreshToken)).toEqual([
      "new-refresh",
      "new-refresh",
    ])
    globalThis.fetch = async () =>
      Response.json({
        data: {
          protocolVersion: 1,
          issuer: "https://attacker.example/auth",
          oauthResource: "https://datool.example/api/cli",
        },
      })
    await rejects(
      login({
        origin: selected.origin,
        open: async () => {
          throw new Error("Should not open")
        },
        store,
        directory,
      }),
      /Server does not support/
    )
  } finally {
    globalThis.fetch = original
    await rm(directory, { recursive: true, force: true })
  }
})
