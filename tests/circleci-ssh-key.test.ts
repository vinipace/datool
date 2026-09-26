import { afterEach, expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "yaml"

const config = parse(readFileSync(new URL("../.circleci/config.yml", import.meta.url), "utf8"))
const command = config.commands["configure-restricted-ssh"].steps[0].run.command
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "datool-ci-ssh-"))
  directories.push(directory)
  const original = join(directory, "original")
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", original])
  const privateKey = readFileSync(original, "utf8")
  const publicKey = execFileSync("ssh-keygen", ["-y", "-f", original], { encoding: "utf8" })
  const restored = join(directory, ".ssh", "identity")
  const run = (value: string) => spawnSync("bash", ["-eo", "pipefail", "-c", command.replaceAll("$HOME", "$DATOOL_TEST_SSH_HOME")], {
    encoding: "utf8",
    env: {
      ...process.env,
      DATOOL_TEST_SSH_HOME: directory,
      DOKKU_SSH_HOST: "fixture.invalid",
      DATOOL_SSH_KEY_VARIABLE: "DATOOL_TEST_PRIVATE_KEY",
      DATOOL_SSH_HOSTS_VARIABLE: "DATOOL_TEST_HOSTS",
      DATOOL_SSH_KEY_FILE: "identity",
      DATOOL_SSH_HOSTS_FILE: "known_hosts",
      DATOOL_TEST_PRIVATE_KEY: value,
      DATOOL_TEST_HOSTS: "fixture.invalid ssh-ed25519 fixture",
    },
  })
  return { privateKey, publicKey, restored, run }
}

for (const format of ["multiline", "single-line", "crlf"] as const) {
  test(`CircleCI restores a ${format} key with the same identity and restrictive permissions`, () => {
    const { privateKey, publicKey, restored, run } = fixture()
    const input = format === "single-line" ? privateKey.replaceAll("\n", "") : format === "crlf" ? privateKey.replaceAll("\n", "\r\n") : privateKey
    const result = run(input)
    expect(result.status).toBe(0)
    expect(execFileSync("ssh-keygen", ["-y", "-f", restored], { encoding: "utf8" })).toBe(publicKey)
    expect(statSync(restored).mode & 0o777).toBe(0o600)
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe("")
  })
}

test("CircleCI rejects incomplete or corrupt private keys before SSH", () => {
  const { privateKey, run } = fixture()
  for (const input of ["", privateKey.slice(0, -30), "-----BEGIN OPENSSH PRIVATE KEY-----YWJj-----END OPENSSH PRIVATE KEY-----"]) {
    expect(run(input).status).not.toBe(0)
  }
})
