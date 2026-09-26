import * as monaco from "monaco-editor"
const { typescript } = monaco

const environment = globalThis as typeof globalThis & {
  MonacoEnvironment?: monaco.Environment
}
environment.MonacoEnvironment = {
  getWorker: (_id, label) =>
    new Worker(
      `/monaco/${label === "javascript" || label === "typescript" ? "ts" : label === "json" ? "json" : "editor"}.worker.js`,
      { type: "module" }
    ),
}
typescript.javascriptDefaults.setCompilerOptions({
  allowJs: true,
  checkJs: true,
  noEmit: true,
  allowNonTsExtensions: true,
  target: typescript.ScriptTarget.ESNext,
  lib: ["esnext"],
})
typescript.javascriptDefaults.setEagerModelSync(true)

monaco.languages.register({ id: "mustache" })
monaco.languages.setMonarchTokensProvider("mustache", {
  tokenizer: {
    root: [
      [/\{\{[^{}]*\}\}/, "keyword"],
      [/[^{]+/, ""],
      [/\{/, ""],
    ],
  },
})

monaco.languages.register({ id: "eval-template" })
monaco.languages.setMonarchTokensProvider("eval-template", {
  tokenizer: {
    root: [
      [
        /\{\{/,
        {
          token: "delimiter.bracket",
          next: "@expression",
          nextEmbedded: "javascript",
        },
      ],
      [/[^{]+/, "string"],
      [/\{/, "string"],
    ],
    expression: [
      [
        /\}\}/,
        { token: "delimiter.bracket", next: "@pop", nextEmbedded: "@pop" },
      ],
    ],
  },
})

export { monaco, typescript }
