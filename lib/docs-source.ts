import { docs } from "@/.source/server"
import { loader } from "fumadocs-core/source"
import { createElement } from "react"
import { docsIcons } from "@/components/docs/icons"
import { docsPageTreeTransformer } from "./docs-page-tree"

export const docsSource = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
  pageTree: {
    transformers: [docsPageTreeTransformer],
  },
  icon(name) {
    if (!name || !(name in docsIcons)) return undefined
    return createElement(docsIcons[name as keyof typeof docsIcons], {
      className: "size-4 shrink-0",
      "aria-hidden": true,
    })
  },
})

export function docsMarkdownUrl(slugs: string[]) {
  return `/docs${slugs.length ? `/${slugs.join("/")}` : ""}.md`
}

export async function docsMarkdown(
  page: ReturnType<typeof docsSource.getPages>[number]
) {
  return `# ${page.data.title}\n\n${page.data.description ?? ""}\n\n${await page.data.getText("processed")}\n`
}
