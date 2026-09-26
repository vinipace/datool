import { test, expect } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfiguration, serverOrigin } from "../bin/config"

test("configuration is rooted, layered, shell-preserving and controllable", async () => {
  const root = await mkdtemp(join(tmpdir(), "datool-config-"))
  try {
    await mkdir(join(root, "src/deep"), { recursive: true })
    await writeFile(join(root, "package.json"), "{}")
    await writeFile(
      join(root, ".env"),
      "DATOOL_PROJECT_ID=base\nDATOOL_API_KEY=base-key\nDATOOL_BASE_URL=https://file.example\n"
    )
    await writeFile(
      join(root, ".env.local"),
      'DATOOL_PROJECT_ID=local\nDATOOL_API_KEY="local-key" # comment\n'
    )
    await writeFile(join(root, "custom.env"), "DATOOL_PROJECT_ID=custom\n")
    const env: NodeJS.Dict<string> = {
      DATOOL_API_KEY: "shell-key",
      DATOOL_URL: "https://shell.example",
    }
    const config = loadConfiguration(
      ["traces", "list", "--project", "flag"],
      env,
      join(root, "src/deep")
    )
    expect(config.root).toBe(root)
    expect(config.args).toEqual(["traces", "list"])
    expect(env.DATOOL_PROJECT_ID).toBe("flag")
    expect(env.DATOOL_API_KEY).toBe("shell-key")
    expect(env.DATOOL_BASE_URL).toBe("https://shell.example")
    expect(config.sources.DATOOL_PROJECT_ID).toBe("flag")
    const layered: NodeJS.Dict<string> = {}
    loadConfiguration([], layered, root)
    expect(layered.DATOOL_PROJECT_ID).toBe("local")
    expect(layered.DATOOL_API_KEY).toBe("local-key")
    const custom: NodeJS.Dict<string> = {}
    loadConfiguration(["--env-file", "custom.env"], custom, root)
    expect(custom).toEqual({ DATOOL_PROJECT_ID: "custom" })
    const disabled: NodeJS.Dict<string> = {}
    loadConfiguration(["--no-env"], disabled, root)
    expect(disabled).toEqual({})
    expect(() =>
      loadConfiguration(["--env-file", "missing"], {}, root)
    ).toThrow("Cannot load")
    expect(() =>
      loadConfiguration(["--env-file", "custom.env", "--no-env"], {}, root)
    ).toThrow("cannot be combined")
    const equalShell: NodeJS.Dict<string> = { DATOOL_PROJECT_ID: "base" }
    loadConfiguration([], equalShell, root)
    expect(equalShell.DATOOL_PROJECT_ID).toBe("base")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("host validation cannot leak credentials in URLs or use remote HTTP", () => {
  expect(serverOrigin("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000")
  for (const value of [
    "https://user:secret@example.com",
    "http://example.com",
    "https://example.com/path",
    "https://example.com?key=secret",
  ]) {
    expect(() => serverOrigin(value)).toThrow("Datool host")
  }
})
