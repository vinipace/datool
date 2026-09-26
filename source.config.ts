import { defineConfig, defineDocs } from "fumadocs-mdx/config"

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    postprocess: {
      includeProcessedMarkdown: {
        stringify(node, _parent, state, info) {
          if (
            node.type === "mdxJsxFlowElement" &&
            (node.name === "Tabs" || node.name === "Tab")
          ) {
            return state.containerFlow(node, info)
          }
        },
      },
    },
  },
})

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      themes: { light: "github-light", dark: "github-dark" },
    },
  },
})
