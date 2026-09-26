import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { checkCoverage } from "../scripts/check-storybook-coverage.mjs"

const temporaryRoots: string[] = []
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "datool-storybook-coverage-"))
  temporaryRoots.push(root)
  const write = (file: string, source: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), source)
  }
  write(
    "components/ui/button.tsx",
    "export function Button() { return <button /> }"
  )
  write(
    "components/ui/button.stories.tsx",
    'import { Button } from "./button"; export default { component: Button }; export const Default = {};'
  )
  const manifest = (entries: unknown[]) =>
    write(".storybook/coverage/ui.json", JSON.stringify(entries))
  const direct = {
    component: "components/ui/button.tsx",
    kind: "direct",
    story: "components/ui/button.stories.tsx",
  }
  manifest([direct])
  return { root, write, manifest, direct }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe("Storybook component coverage", () => {
  test("accepts direct and reachable composite coverage through a barrel", () => {
    const { root, write, manifest, direct } = fixture()
    write("components/ui/icon.tsx", "export const Icon = () => <svg />")
    write("components/ui/index.ts", 'export { Icon } from "./icon"')
    write(
      "components/ui/button.tsx",
      'import { Icon } from "./index"; export const Button = () => <button><Icon /></button>'
    )
    manifest([
      direct,
      {
        component: "components/ui/icon.tsx",
        kind: "composite",
        story: direct.story,
        reason: "Button renders Icon",
      },
    ])
    expect(checkCoverage(root).errors).toEqual([])
  })

  test("new components, stale entries and duplicate claims fail", () => {
    const { root, write, manifest, direct } = fixture()
    write("components/ui/input.tsx", "export const Input = () => <input />")
    manifest([
      direct,
      direct,
      {
        component: "components/ui/deleted.tsx",
        kind: "helper",
        reason: "Removed",
      },
    ])
    const errors = checkCoverage(root).errors
    for (const expected of [
      "Duplicate classification: components/ui/button.tsx",
      "Stale or out-of-scope component: components/ui/deleted.tsx",
      "Missing classification: components/ui/input.tsx",
    ])
      expect(errors).toContain(expected)
  })

  test("type-only imports do not prove visual coverage", () => {
    const { root, write } = fixture()
    write(
      "components/ui/button.stories.tsx",
      'import type { Button } from "./button"; export default {}; export const Default = {};'
    )
    expect(checkCoverage(root).errors).toContain(
      "components/ui/button.tsx: unreachable from components/ui/button.stories.tsx through runtime imports"
    )
  })

  test("requires real CSF and meaningful helper explanations", () => {
    const { root, write, manifest, direct } = fixture()
    write(
      "components/ui/button.stories.tsx",
      'import { Button } from "./button"; export default { component: Button };'
    )
    expect(
      checkCoverage(root).errors.some((error: string) =>
        error.includes("named story exports")
      )
    ).toBe(true)
    manifest([{ ...direct, kind: "helper" }])
    expect(checkCoverage(root).errors).toContain(
      "components/ui/button.tsx: helper requires a reason"
    )
  })

  test("built index must actually contain story entries, not only docs", () => {
    const { root, write, direct } = fixture()
    write(
      "storybook-static/index.json",
      JSON.stringify({
        entries: { docs: { type: "docs", importPath: `./${direct.story}` } },
      })
    )
    expect(checkCoverage(root, { builtIndex: true }).errors).toContain(
      `${direct.story}: missing from built Storybook index`
    )
    write(
      "storybook-static/index.json",
      JSON.stringify({
        entries: {
          default: { type: "story", importPath: `./${direct.story}` },
        },
      })
    )
    expect(checkCoverage(root, { builtIndex: true }).errors).toEqual([])
  })
})
