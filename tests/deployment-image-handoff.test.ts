import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { parse } from "yaml"

const workflow = parse(
  readFileSync(
    new URL("../.circleci/config.yml", import.meta.url),
    "utf8"
  )
)
const steps = (workflow.jobs.deploy.steps as {
  run?: { name: string; command: string }
}[]).flatMap((step) => step.run ? [step.run] : [])
const checksum = steps.find(
  (step) => step.name === "Verify the image archive"
)!.command
const deploy = steps.find(
  (step) => step.name === "Import and release the verified image through Dokku"
)!.command
const commit = "a".repeat(40)
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function fixture(image = `datool-release:${commit}-123-1`, branch = "main") {
  const directory = mkdtempSync(join(tmpdir(), "datool-image-handoff-"))
  directories.push(directory)
  mkdirSync(join(directory, "bin"))
  writeFileSync(
    join(directory, "bin/ssh"),
    '#!/bin/sh\nprintf "%s\\n" "$@" > ssh-args.txt\ncat > received-image.tar.gz\n',
    { mode: 0o755 }
  )
  const files = {
    "image.tar.gz": "verified archive bytes",
    "image-ref.txt": `${image}\n`,
    "image-size.txt": "2500000000\n",
  }
  for (const [name, contents] of Object.entries(files))
    writeFileSync(join(directory, name), contents)
  writeFileSync(
    join(directory, "image.sha256"),
    Object.entries(files)
      .map(
        ([name, contents]) =>
          `${createHash("sha256").update(contents).digest("hex")}  ${name}\n`
      )
      .join("")
  )
  return {
    directory,
    run: () =>
      spawnSync(
        "bash",
        ["-e", "-o", "pipefail", "-c", `${checksum}\n${deploy}`],
        {
          cwd: directory,
          env: {
            ...process.env,
            PATH: `${join(directory, "bin")}:${process.env.PATH}`,
            CIRCLE_SHA1: commit,
            CIRCLE_PIPELINE_NUMBER: "123",
            CIRCLE_BUILD_NUM: "2",
            CIRCLE_BRANCH: branch,
            DOKKU_SSH_HOST: "dokku.example.invalid",
          },
          encoding: "utf8",
        }
      ),
  }
}

test("a deploy retry imports the exact archive and recorded build-attempt tag", () => {
  const { directory, run } = fixture()
  const result = run()
  expect(result.status).toBe(0)
  expect(readFileSync(join(directory, "received-image.tar.gz"), "utf8")).toBe(
    "verified archive bytes"
  )
  expect(readFileSync(join(directory, "ssh-args.txt"), "utf8")).toContain(
    "datool-deploy@dokku.example.invalid\n"
  )
  expect(readFileSync(join(directory, "ssh-args.txt"), "utf8")).toContain(
    `disk:load-image\ndatool\ndatool-release:${commit}-123-1\n2500000000\n`
  )
})

test("a corrupted archive stops before contacting production", () => {
  const { directory, run } = fixture()
  writeFileSync(join(directory, "image.tar.gz"), "changed archive")
  expect(run().status).not.toBe(0)
  expect(() => readFileSync(join(directory, "ssh-args.txt"))).toThrow()
})

test("an image from another commit is rejected even with valid checksums", () => {
  const { directory, run } = fixture(`datool-release:${"b".repeat(40)}-123-1`)
  expect(run().status).not.toBe(0)
  expect(() => readFileSync(join(directory, "ssh-args.txt"))).toThrow()
})

test("an image from another pipeline is rejected even with valid checksums", () => {
  const { directory, run } = fixture(`datool-release:${commit}-124-1`)
  expect(run().status).not.toBe(0)
  expect(() => readFileSync(join(directory, "ssh-args.txt"))).toThrow()
})

test("a feature branch cannot import an image into production", () => {
  const { directory, run } = fixture(undefined, "codex/feature")
  expect(run().status).not.toBe(0)
  expect(() => readFileSync(join(directory, "ssh-args.txt"))).toThrow()
})

test("tampered size metadata stops before contacting production", () => {
  const { directory, run } = fixture()
  writeFileSync(join(directory, "image-size.txt"), "1\n")
  expect(run().status).not.toBe(0)
  expect(() => readFileSync(join(directory, "ssh-args.txt"))).toThrow()
})

test("an unconfigured deployment host fails before SSH setup", () => {
  const { directory } = fixture()
  const configure = workflow.commands["configure-restricted-ssh"].steps[0].run.command
  const result = spawnSync("bash", ["-e", "-c", configure], {
    cwd: directory,
    env: { ...process.env, HOME: directory, DOKKU_SSH_HOST: "" },
    encoding: "utf8",
  })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain("Configure DOKKU_SSH_HOST in the restricted CircleCI context")
  expect(() => readFileSync(join(directory, ".ssh/datool_deploy"))).toThrow()
})
