import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  open,
} from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { serverOrigin } from "./config"

const profileSchema = z.object({
  id: z.string().uuid(),
  origin: z.string(),
  projectId: z.string().min(1).max(200),
  organizationId: z.string().min(1).max(200),
})
export type Profile = z.infer<typeof profileSchema>
const credentialSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number(),
  clientId: z.string().min(1),
  tokenEndpoint: z.string(),
  revocationEndpoint: z.string().optional(),
})
export type Credential = z.infer<typeof credentialSchema>
export type CredentialStore = {
  read(id: string): Promise<string | null>
  write(id: string, secret: string): Promise<void>
  remove(id: string): Promise<void>
}
export const configDirectory = () =>
  process.env.DATOOL_CONFIG_DIR ?? join(homedir(), ".config", "datool")

/** Serialize refresh rotation across CLI processes. Re-login replaces a crashed login. */
export async function withCredentialLock<T>(
  id: string,
  action: () => Promise<T>,
  directory = configDirectory()
): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `.refresh-${id}.lock`)
  const deadline = Date.now() + 30_000
  while (true) {
    try {
      const file = await open(path, "wx", 0o600)
      try {
        await file.writeFile(String(process.pid))
        return await action()
      } finally {
        await file.close()
        await rm(path, { force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      try {
        const pid = Number(await readFile(path, "utf8"))
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") {
              throw new Error("A previous login refresh stopped unexpectedly. Run datool auth login again.")
            }
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        throw error
      }
      if (Date.now() >= deadline)
        throw new Error(
          "Another Datool command is refreshing this login. Retry shortly, or run datool auth login if it stopped unexpectedly."
        )
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

/** No plaintext fallback: agents and headless hosts can use API-key environment auth. */
export const systemCredentialStore: CredentialStore = {
  async read(id) {
    try {
      const { Entry } = await import("@napi-rs/keyring")
      return new Entry("datool-cli", id).getPassword()
    } catch {
      throw new Error(
        "Cannot read the OS credential store. Unlock it or use DATOOL_API_KEY for headless use."
      )
    }
  },
  async write(id, secret) {
    try {
      const { Entry } = await import("@napi-rs/keyring")
      new Entry("datool-cli", id).setPassword(secret)
    } catch {
      throw new Error(
        "Cannot save to the OS credential store. No credentials were written to a plaintext file."
      )
    }
  },
  async remove(id) {
    try {
      const { Entry } = await import("@napi-rs/keyring")
      new Entry("datool-cli", id).deletePassword()
    } catch {
      throw new Error(
        "Cannot remove credentials from the OS credential store. Unlock it and retry logout."
      )
    }
  },
}

export async function readProfile(
  directory = configDirectory()
): Promise<Profile | null> {
  let raw: string
  try {
    raw = await readFile(join(directory, "profile.json"), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw new Error("Cannot read the Datool login profile.")
  }
  try {
    const profile = profileSchema.parse(JSON.parse(raw))
    profile.origin = serverOrigin(profile.origin)
    return profile
  } catch {
    throw new Error(
      "Invalid Datool login profile. Run datool auth login again."
    )
  }
}

export async function readCredential(
  profile: Profile,
  store = systemCredentialStore
): Promise<Credential> {
  const raw = await store.read(profile.id)
  try {
    const credential = credentialSchema.parse(JSON.parse(raw ?? "null"))
    for (const endpoint of [
      credential.tokenEndpoint,
      credential.revocationEndpoint,
    ].filter(Boolean)) {
      const url = new URL(endpoint!)
      if (
        url.origin !== profile.origin ||
        url.username ||
        url.password ||
        url.hash ||
        url.search
      )
        throw new Error()
    }
    return credential
  } catch {
    throw new Error(
      "Saved login is missing or invalid. Run datool auth login again."
    )
  }
}

export async function saveLogin(
  profile: Profile,
  credential: Credential,
  store = systemCredentialStore,
  directory = configDirectory()
) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const previous = await readProfile(directory)
  await store.write(profile.id, JSON.stringify(credential))
  const temporary = join(directory, `.profile-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify(profile, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    })
    await rename(temporary, join(directory, "profile.json"))
  } catch {
    await rm(temporary, { force: true })
    await store.remove(profile.id)
    throw new Error("Could not save the login profile.")
  }
  if (previous && previous.id !== profile.id) await store.remove(previous.id)
}

export async function clearLogin(
  profile: Profile,
  store = systemCredentialStore,
  directory = configDirectory()
) {
  await store.remove(profile.id)
  await rm(join(directory, "profile.json"), { force: true })
}
