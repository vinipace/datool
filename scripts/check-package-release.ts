import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const app = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
if (app.private !== true) throw new Error('The application root must remain private')
const expected = process.argv[2]
const selected = process.argv[3] ?? 'all'
if (!['sdk', 'cli', 'all'].includes(selected)) throw new Error('Expected sdk, cli or all')
const names = selected === 'all' ? ['sdk', 'cli'] : [selected]
for (const name of names) {
  const directory = join(root, 'packages', name)
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  if (manifest.name !== `@datool/${name}` || manifest.private || manifest.publishConfig?.access !== 'public') {
    throw new Error(`Unexpected release metadata for ${name}`)
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || (expected && expected !== manifest.version)) {
    throw new Error(`${manifest.name} must match the requested stable release`)
  }
  if (manifest.license !== 'Apache-2.0' || !(await readFile(join(directory, 'LICENSE'), 'utf8')).includes('Apache License')) {
    throw new Error(`${manifest.name} must include its Apache-2.0 license`)
  }
  console.info(`Release metadata ready: ${manifest.name}@${manifest.version}`)
}
