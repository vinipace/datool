import { build } from "esbuild"

await build({
  entryPoints: ["packages/eve-bridge/index.ts"],
  outfile: "packages/eve-bridge/dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  target: "node24",
  // Application data is resolved at runtime and is never a build asset. Keep
  // Nitro's static file tracer from globbing the operator's .data directory.
  // The application image ships public assets and scorer sources explicitly.
  define: { "process.cwd": "datoolRuntimeCwd" },
  banner: {
    js: 'import { createRequire as createDatoolRequire } from "node:module"; const require = createDatoolRequire(import.meta.url); const datoolRuntimeCwd = process.cwd.bind(process);',
  },
  tsconfig: "tsconfig.json",
})
