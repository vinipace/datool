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

test("CI images can deploy only after source checks and image acceptance succeed", () => {
  const deployment = workflow.workflows.ci.jobs.find(
    (job: string | Record<string, unknown>) =>
      typeof job === "object" && "deploy" in job
  ).deploy
  expect(deployment.requires).toContain("verify")
  expect(deployment.requires).toContain("production-image")
  expect(deployment.filters.branches.only).toBe("main")
  const checks = workflow.jobs.verify.steps.flatMap(
    (step: { run?: { command: string } }) => step.run ? [step.run.command] : []
  )
  expect(checks.some((command: string) => command.includes("bun run typecheck"))).toBe(true)
  for (const name of ["regression", "nightly-regression"]) {
    expect(workflow.workflows[name].jobs.some(
      (job: string | Record<string, unknown>) =>
        job === "deploy" || (typeof job === "object" && "deploy" in job)
    )).toBe(false)
  }
})

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

for (const failingCommand of [
  "",
  "run lint",
  "run check:styles",
  "run typecheck",
  "-m unittest discover -s tests -p dokku_",
  "-m unittest discover -s tests -p deployment_notifications",
  "--no-env-file test",
]) {
  test(`parallel release checks ${failingCommand ? `reject failure in ${failingCommand}` : "accept success only after all groups finish"}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "datool-release-checks-"))
    directories.push(directory)
    const stub = `#!/bin/bash
printf '%s\\n' "$*" >> "$CHECK_CALLS"
if [ -n "$FAIL_COMMAND" ]; then
  case "$*" in "$FAIL_COMMAND"*) exit 1;; esac
fi
`
    for (const binary of ["bun", "python3"])
      writeFileSync(join(directory, binary), stub, { mode: 0o755 })
    const command = workflow.jobs.verify.steps.find(
      (step: { run?: { name: string } }) =>
        step.run?.name === "Verify source and release contracts in parallel"
    ).run.command
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", command], {
      env: {
        // Exclude shell startup files and exported pyenv functions from CI.
        // Only the injected commands and standard shell utilities may run.
        NODE_ENV: "test",
        PATH: `${directory}:/usr/bin:/bin`,
        CHECK_CALLS: join(directory, "calls"),
        FAIL_COMMAND: failingCommand,
      },
      encoding: "utf8",
      timeout: 5000,
    })
    expect(result.status).toBe(failingCommand ? 1 : 0)
    const calls = readFileSync(join(directory, "calls"), "utf8")
    for (const invocation of ["run lint", "run typecheck", "unittest discover"])
      expect(calls).toContain(invocation)
    for (const group of ["lint", "types", "critical"])
      expect(new RegExp(`(?:PASS|FAIL) ${group}\\n`).test(result.stdout)).toBe(true)
  })
}

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

for (const [status, expected] of [
  ["running", 0],
  ["crashed", 1],
  ["missing", 1],
] as const) test(`deployment requires a running Build worker (${status})`, () => {
  const { directory } = fixture()
  writeFileSync(join(directory, "process-fixture.txt"), [
    "Status web 1: running",
    "Status worker 1: running",
    ...(status === "missing" ? [] : [`Status buildworker 1: ${status}`]),
  ].join("\n") + "\n")
  writeFileSync(join(directory, "bin/ssh"), '#!/bin/sh\ncase "$*" in *--running) echo true ;; *) cat process-fixture.txt ;; esac\n', { mode: 0o755 })
  const command = steps.find(step => step.name === "Verify web, ingestion, and Build processes")!.command
  const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", command], {
    cwd: directory,
    env: { ...process.env, PATH: `${join(directory, "bin")}:${process.env.PATH}`, DOKKU_SSH_HOST: "dokku.example.invalid" },
    encoding: "utf8",
  })
  expect(result.status).toBe(expected)
})
