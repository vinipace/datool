import { readdir, readFile, lstat, realpath } from "node:fs/promises"
import { resolve, relative, sep, extname } from "node:path"
import { build } from "esbuild"
import { appRequest } from "./request"
import {
  deploymentBundle,
  deploymentConfig,
  deploymentMaxBytes,
  type DeploymentBundle,
} from "../src/lib/deploy/contracts"

/** Never import user code into the CLI process, which holds the deployment key. */
export async function packDeployment(
  directory: string
): Promise<DeploymentBundle> {
  const root = await realpath(resolve(directory))
  const files: string[] = []
  async function walk(path: string) {
    let entries
    try {
      entries = await readdir(resolve(root, path), { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (
        entry.name.startsWith(".") ||
        ["node_modules", "dist"].includes(entry.name)
      )
        continue
      const name = `${path}/${entry.name}`
      if (entry.isSymbolicLink())
        throw new Error(`Symlinks cannot be deployed: ${name}`)
      if (entry.isDirectory()) await walk(name)
      else if (entry.isFile()) files.push(name)
      if (files.length > 400)
        throw new Error("A deployment supports at most 400 files.")
    }
  }
  for (const path of ["agents", "skills", "tools", "sources"]) {
    const info = await lstat(resolve(root, path)).catch(() => null)
    if (info?.isSymbolicLink())
      throw new Error(`Symlinks cannot be deployed: ${path}`)
    await walk(path)
  }
  const text = async (path: string) => {
    const info = await lstat(resolve(root, path))
    if (!info.isFile() || info.size > 2 * 1024 * 1024)
      throw new Error(`File is invalid or too large: ${path}`)
    return readFile(resolve(root, path), "utf8")
  }
  const configPath = resolve(root, "datool.json")
  const config = deploymentConfig.parse(
    await lstat(configPath)
      .then(() => text("datool.json").then(JSON.parse))
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
        throw error
      })
  )
  const tools = files.filter((p) => /^tools\/[^/]+\.(ts|js|mts|mjs)$/.test(p))
  const collectors = files.filter((p) =>
    /^sources\/[^/]+\.(ts|js|mts|mjs)$/.test(p)
  )
  const name = (p: string) => p.split("/").at(-1)!.slice(0, -extname(p).length)
  const entries = [...tools, ...collectors]
  const bundled = entries.length
    ? await build({
        stdin: {
          contents:
            entries
              .map(
                (p, i) => `import module${i} from ${JSON.stringify("./" + p)};`
              )
              .join("\n") +
            `\nexport const tools = {${tools.map((p, i) => `${JSON.stringify(name(p))}:module${i}`).join(",")}};` +
            `\nexport const sources = {${collectors.map((p, i) => `${JSON.stringify(name(p))}:module${tools.length + i}`).join(",")}};`,
          resolveDir: root,
          sourcefile: "datool-entry.ts",
        },
        banner: {
          js: 'import { createRequire as __datoolCreateRequire } from "node:module";const require = __datoolCreateRequire("/workspace/deployment.cjs");',
        },
        bundle: true,
        write: false,
        platform: "node",
        format: "esm",
        target: "node22",
        sourcemap: false,
        minify: true,
        plugins: [
          {
            name: "deployment-boundary",
            setup(plugin) {
              plugin.onLoad({ filter: /.*/ }, async (args) => {
                const actual = await realpath(args.path)
                const path = relative(root, actual)
                if (
                  path.startsWith(`..${sep}`) ||
                  path === ".." ||
                  resolve(root, path) !== actual ||
                  path
                    .split(sep)
                    .some(
                      (p, i, parts) =>
                        p.startsWith(".") &&
                        !(
                          i > 0 &&
                          parts[i - 1] === "node_modules" &&
                          [".bun", ".pnpm"].includes(p)
                        )
                    )
                )
                  throw new Error(
                    "Deploy imports must stay inside the folder and cannot include hidden files."
                  )
                return undefined
              })
            },
          },
        ],
      })
    : null
  const document = async (path: string) => ({
    path,
    title:
      (await text(path)).match(/^# +(.+)$/m)?.[1]?.slice(0, 200) ??
      path.split("/").at(-1)!,
    text: await text(path),
  })
  const bundle = deploymentBundle.parse({
    version: 1,
    config,
    code:
      bundled?.outputFiles[0].text ??
      "export const tools={};export const sources={};",
    tools: tools.map(name),
    collectors: collectors.map(name),
    agents: await Promise.all(
      files
        .filter((p) => /^agents\/[^/]+\/instructions\.md$/.test(p))
        .map(async (p) => {
          const base = p.slice(0, -"instructions.md".length)
          return {
            slug: p.split("/")[1],
            instructions: await text(p),
            configuration: files.includes(`${base}agent.json`)
              ? JSON.parse(await text(`${base}agent.json`))
              : {},
          }
        })
    ),
    skills: await Promise.all(
      files
        .filter((p) => p.startsWith("skills/") && /\.md$/.test(p))
        .map(document)
    ),
    sources: await Promise.all(
      files
        .filter(
          (p) => p.startsWith("sources/") && /\.(md|txt|json|csv)$/.test(p)
        )
        .map(document)
    ),
  })
  if (Buffer.byteLength(JSON.stringify(bundle)) > deploymentMaxBytes - 1024)
    throw new Error("Deployment exceeds 4 MiB.")
  if (
    !bundle.agents.length &&
    !bundle.tools.length &&
    !bundle.sources.length &&
    !bundle.collectors.length
  )
    throw new Error("No deployable agents, tools or sources found.")
  return bundle
}

export async function deployCommand(args: string[]) {
  const origin =
    process.env.DATOOL_BASE_URL ??
    process.env.DATOOL_URL ??
    "http://127.0.0.1:3000"
  if (args[0] === "status") {
    console.info(
      JSON.stringify(await appRequest(origin, "/api/deployments"), null, 2)
    )
    return
  }
  const unknown = args.filter(
    (arg) => arg.startsWith("-") && arg !== "--dry-run"
  )
  if (unknown.length) throw new Error(`Unknown deploy option: ${unknown[0]}`)
  const paths = args.filter((arg) => !arg.startsWith("-"))
  if (paths.length > 1)
    throw new Error("Usage: datool deploy [folder] [--dry-run]")
  const bundle = await packDeployment(paths[0] ?? ".")
  if (args.includes("--dry-run")) {
    console.info(
      JSON.stringify(
        {
          dryRun: true,
          agents: bundle.agents.map((a) => a.slug),
          tools: bundle.tools,
          sources: bundle.sources.map((s) => s.path),
          collectors: bundle.collectors,
          skills: bundle.skills.map((s) => s.path),
          bytes: Buffer.byteLength(JSON.stringify(bundle)),
        },
        null,
        2
      )
    )
    return
  }
  const current = await appRequest<{ id: string } | null>(
    origin,
    "/api/deployments"
  )
  const data = await appRequest(
    origin,
    "/api/deployments",
    { bundle, expectedDeploymentId: current?.id ?? null },
    { timeoutMs: 240_000 }
  )
  console.info(JSON.stringify(data, null, 2))
}
