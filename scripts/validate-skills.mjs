import assert from "node:assert/strict"
import { readdir, readFile, lstat } from "node:fs/promises"
import { resolve, dirname, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const names = [
  "datool",
  "datool-traces",
  "datool-scorers",
  "datool-datasets",
  "datool-evaluations",
  "datool-analytics",
]
const skills = resolve(root, "skills")
assert.deepEqual(
  (await readdir(skills)).sort(),
  [...names, "README.md", "AGENTS.md"].sort()
)

async function walk(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    assert(!entry.isSymbolicLink(), `Ship files, not local symlinks: ${path}`)
    if (entry.isDirectory()) files.push(...(await walk(path)))
    else files.push(path)
  }
  return files
}

const files = await walk(skills)
let assets = 0
for (const name of names) {
  const text = await readFile(resolve(skills, name, "SKILL.md"), "utf8")
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  assert(frontmatter, `Missing frontmatter: ${name}`)
  // Full YAML parsing and discovery are exercised by the skills CLI in CI.
  assert.match(frontmatter[1], new RegExp(`^name: ${name}$`, "m"))
  assert.match(frontmatter[1], /^description: \S.+$/m)
  assert((await lstat(resolve(skills, name, "agents/openai.yaml"))).isFile())
}
for (const path of files) {
  const text = await readFile(path, "utf8")
  assert(
    !/^(<{7} |={7}$|>{7} )/m.test(text),
    `Unresolved merge conflict: ${path}`
  )
  assert(
    /\.(md|mdx|json|yaml)$/.test(path),
    `Unexpected distributed file type: ${path}`
  )
  // User skills must not carry host access details or local operational files.
  const privateContent = [
    /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/,
    /(?:\/Users\/|\/home\/|\/root\/)[A-Za-z0-9_.-]+/,
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
    /\b(?:ssh|scp|dokku)\s+(?:-|[A-Za-z0-9])/i,
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/,
  ]
  assert(
    !privateContent.some((pattern) => pattern.test(text)),
    `Private operational content is not distributable: ${path}`
  )
  if (path.endsWith(".json")) {
    JSON.parse(text)
    assets++
  }
  if (!path.endsWith(".md")) continue
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const link = match[1].split("#")[0]
    if (!link || /^https?:\/\//.test(link)) continue
    const destination = resolve(dirname(path), link)
    const boundary = dirname(path) === skills ? root : skills
    const rel = relative(boundary, destination)
    assert(!rel.startsWith(".."), `Link escapes pack: ${link}`)
    assert((await lstat(destination)).isFile(), `Broken link: ${link}`)
  }
}
assert.equal(assets, 13)
console.log(
  `PASS ${names.length} skills, ${assets} JSON assets and all local links`
)
