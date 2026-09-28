import ts from 'typescript'
import path from 'node:path'

/** Build editor types from the actual shared components, including their dependencies. */
export function traceViewTypes() {
  const root = process.cwd()
  const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile)
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  const program = ts.createProgram(['src/browser/trace-view-ui.ts', 'components/ui/chart.tsx', 'src/lib/tracer/contracts.ts'], {
    ...options, noEmit: false, declaration: true, emitDeclarationOnly: true, incremental: false,
    declarationMap: false, types: [], preserveSymlinks: true, rootDir: root, outDir: root,
  })
  const libraries = {}
  const uri = file => `file:///${path.relative(root, file).split(path.sep).join('/')}`
  program.emit(undefined, (file, text) => { libraries[uri(file)] = text }, undefined, true)
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile && !program.isSourceFileDefaultLibrary(source)) libraries[uri(source.fileName)] = source.text
  }
  libraries['file:///node_modules/@datool/ui/index.d.ts'] = 'export * from "../../../src/browser/trace-view-ui";'
  libraries['file:///node_modules/@datool/charts/index.d.ts'] = 'export * from "recharts"; export * from "../../../components/ui/chart";'
  libraries['file:///view-props.d.ts'] = 'type TraceViewData = import("./src/lib/tracer/contracts").TraceSummary & Partial<Pick<import("./src/lib/tracer/contracts").TraceDetail, "spans" | "scores" | "spanStats">>; type ViewProps = { trace: TraceViewData; fields: Record<string, import("./src/lib/tracer/contracts").JsonValue>; context: { unsaved: boolean; fieldErrors?: Record<string,string>; fieldRevisions?: Record<string,number> } } & ({ kind: "trace"; object: TraceViewData } | { kind: "dataset-item"; object: import("./src/lib/tracer/contracts").DatasetItem });'
  // Keep only declarations reachable from the public API. Implementation-only
  // imports (for example the complete icon catalog) should not enter Monaco.
  const files = new Map(Object.entries(libraries).map(([key, text]) => [path.join(root, key.slice('file:///'.length)), text]))
  const directories = new Set()
  for (const file of files.keys()) {
    for (let dir = path.dirname(file); dir.startsWith(root); dir = path.dirname(dir)) directories.add(dir)
  }
  const host = {
    fileExists: file => files.has(file) || (file.endsWith('.json') && ts.sys.fileExists(file)),
    readFile: file => files.get(file) ?? ts.sys.readFile(file),
    directoryExists: dir => directories.has(dir) || ts.sys.directoryExists(dir),
    getCurrentDirectory: () => root,
  }
  const selected = {}
  function visit(file) {
    const text = files.get(file)
    if (!text || selected[uri(file)]) return
    selected[uri(file)] = text
    const info = ts.preProcessFile(text, true, true)
    for (const imported of info.importedFiles) {
      const resolved = ts.resolveModuleName(imported.fileName, file, options, host).resolvedModule
      if (resolved) {
        visit(resolved.resolvedFileName)
        if (!imported.fileName.startsWith('.') && !imported.fileName.startsWith('@/')) {
          const alias = path.join(root, 'node_modules', `${imported.fileName}.d.ts`)
          const index = path.join(root, 'node_modules', imported.fileName, 'index.d.ts')
          if (resolved.resolvedFileName !== alias && resolved.resolvedFileName !== index && !files.has(alias)) {
            const target = path.relative(path.dirname(alias), resolved.resolvedFileName).replace(/\.d\.ts$/, '').split(path.sep).join('/')
            selected[uri(alias)] = `export * from "./${target}";`
          }
        }
      }
    }
    for (const reference of info.referencedFiles) visit(path.resolve(path.dirname(file), reference.fileName))
  }
  for (const file of ['node_modules/@datool/ui/index.d.ts', 'node_modules/@datool/charts/index.d.ts', 'view-props.d.ts']) visit(path.join(root, file))
  return selected
}
