import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { parse } from "yaml"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const release = parse(read("../.github/workflows/publish-python-sdk.yml"))
const checks = parse(read("../.github/workflows/python-sdk.yml"))
const circle = parse(read("../.circleci/config.yml"))
const script = read("../scripts/ci-python-sdk.sh")

test("automatic Python CI runs on CircleCI while GitHub verification is release-only", () => {
  expect(Object.keys(checks.on)).toEqual(["workflow_call"])
  expect(Object.keys(release.on)).toEqual(["workflow_dispatch"])
  expect(checks.on.workflow_call.inputs["release-version"].required).toBe(true)
  expect(circle.workflows.ci.jobs).toContain("python-verify")
  expect(circle.jobs["python-verify"].steps.find((step: { run?: { command?: string } }) => step.run?.command === "bash scripts/ci-python-sdk.sh")).toEqual({
    run: { name: "Verify Python SDK wheel, runtimes, and real ingestion", command: "bash scripts/ci-python-sdk.sh" },
  })
  expect(checks.jobs.package.steps.find((step: { run?: string }) => step.run === "bash scripts/ci-python-sdk.sh")).toEqual({
    name: "Verify the exact release wheel and supported Python runtimes",
    run: "bash scripts/ci-python-sdk.sh",
  })
})

test("manual Python publication requires main, an explicit version, and full verification", () => {
  expect(release.on.workflow_dispatch.inputs.version.required).toBe(true)
  expect(release.jobs.verify.if).toContain("github.repository == 'vinipace/datool'")
  expect(release.jobs.verify.if).toContain("github.ref == 'refs/heads/main'")
  expect(release.jobs.verify.uses).toBe("./.github/workflows/python-sdk.yml")
  expect(release.jobs.verify.with["release-version"]).toBe("${{ inputs.version }}")
  expect(release.jobs.publish.needs).toBe("verify")
  expect(release.jobs.publish.if).toBe(release.jobs.verify.if)
  expect(checks.jobs.package.env.CI_OPERATION).toBe("publish-python")
  expect(checks.jobs.package.env.RELEASE_VERSION).toBe("${{ inputs.release-version }}")
  expect(script).toContain('test "$ci_branch" = main')
  expect(script).toContain('test -n "${RELEASE_VERSION:-}"')
  expect(script).toContain("python_versions='3.10 3.12 3.14'")
  expect(release.concurrency["cancel-in-progress"]).toBe(false)
  expect(checks.concurrency["cancel-in-progress"]).toBe(false)
})

test("only the isolated publishing job receives PyPI identity credentials", () => {
  expect(release.permissions).toEqual({ contents: "read" })
  expect(checks.permissions).toEqual({ contents: "read" })
  expect(release.jobs.publish.permissions["id-token"]).toBe("write")
  expect(release.jobs.publish.environment.name).toBe("pypi")
  expect(release.jobs.publish.steps.some((step: { uses?: string; run?: string }) => step.run || step.uses?.startsWith("actions/checkout"))).toBe(false)
  expect(release.jobs["verify-published"].permissions?.["id-token"]).toBeUndefined()
})

test("persistence and publishing consume the same wheel and registry verification follows upload", () => {
  const artifact = (steps: { uses?: string; with?: { name?: string } }[]) => steps.find(step => step.uses?.startsWith("actions/download-artifact"))?.with?.name
  const steps = checks.jobs.package.steps as { uses?: string; run?: string; with?: { name?: string; path?: string } }[]
  const verify = steps.findIndex(step => step.run === "bash scripts/ci-python-sdk.sh")
  const upload = steps.findIndex(step => step.uses?.startsWith("actions/upload-artifact"))
  expect(verify).toBeGreaterThan(-1)
  expect(upload).toBeGreaterThan(verify)
  expect(script).toContain('DATOOL_TEST_PYTHON_WHEEL="${wheels[0]}" bun run test:python:integration')
  expect(script).toContain('packages/python-sdk/dist/*.whl pytest -r "$consumer_root/requirements.txt"')
  expect(steps[upload].with).toEqual({ name: "python-sdk-3.12", path: "packages/python-sdk/dist/*" })
  expect(artifact(release.jobs.publish.steps)).toBe("python-sdk-3.12")
  expect(artifact(release.jobs["verify-published"].steps)).toBe("python-sdk-3.12")
  expect(release.jobs["verify-published"].needs).toBe("publish")
})
