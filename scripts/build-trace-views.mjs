import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { compile } from 'tailwindcss'
import ts from 'typescript'
import { traceViewTypes } from './build-trace-view-types.mjs'

const outdir = 'public/trace-views'
await mkdir(outdir, { recursive: true })
const globals = (await readFile('app/globals.css', 'utf8')).replace(/^@import .*;\s*$/gm, '')
const theme = `@layer theme, base, components, utilities;\n${await readFile('node_modules/tailwindcss/theme.css', 'utf8')}\n${await readFile('node_modules/tailwindcss/preflight.css', 'utf8')}\n${globals}\n@tailwind utilities;`
const options = { bundle: true, minify: true, platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, metafile: true }
const runtime = await build({ ...options, entryPoints: ['src/browser/trace-view-runtime.tsx'], outfile: `${outdir}/runtime.js` })
// Avoid a second React instance in the lazily loaded chart bundle.
const charts = await build({ ...options, entryPoints: ['src/browser/trace-view-charts.ts'], outfile: `${outdir}/charts.js`, plugins: [{
  name: 'shared-react', setup(build) {
    build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'shared-react' }))
    build.onLoad({ filter: /.*/, namespace: 'shared-react' }, () => ({ contents: 'module.exports = window.__datoolTraceReact;', loader: 'js' }))
  },
}] })
const candidates = new Set()
for (const file of new Set([...Object.keys(runtime.metafile.inputs), ...Object.keys(charts.metafile.inputs)])) {
  if (file.includes('node_modules') || file.includes('shared-react:')) continue
  const source = await readFile(file, 'utf8')
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, source)
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if ([ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral].includes(token)) for (const part of scanner.getTokenValue().split(/\s+/)) candidates.add(part)
  }
}
const css = (await compile(theme)).build([...candidates])
await writeFile(`${outdir}/theme.css`, css)
const buildId = createHash('sha256').update(theme).update(await readFile('bun.lock')).update(await readFile(`${outdir}/runtime.js`)).update(await readFile(`${outdir}/charts.js`)).update(await readFile('src/lib/tracer/trace-view-compiler.ts')).update(await readFile('src/browser/trace-view-compiler.worker.ts')).digest('hex').slice(0, 20)
await build({ ...options, entryPoints: ['src/browser/trace-view-compiler.worker.ts'], outfile: `${outdir}/compiler.js`, define: { ...options.define, TRACE_VIEW_THEME: JSON.stringify(theme), TRACE_VIEW_BUILD_ID: JSON.stringify(buildId) } })
await writeFile(`${outdir}/manifest.json`, JSON.stringify({ buildId }))
await writeFile(`${outdir}/types.json`, JSON.stringify(traceViewTypes()))
console.log(`Built trace view runtime ${buildId}`)
