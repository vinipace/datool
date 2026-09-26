import { expect, test } from "bun:test"
import { createElement, isValidElement } from "react"
import { loader } from "fumadocs-core/source"
import type { Node, Root } from "fumadocs-core/page-tree"
import { docsPageTreeTransformer } from "@/lib/docs-page-tree"

test("docs navigation stays serializable while retaining root and folder icons", () => {
  const source = loader({
    baseUrl: "/docs",
    source: {
      files: [
        {
          type: "page",
          path: "index.mdx",
          data: { title: "Docs", icon: "home" },
        },
        {
          type: "meta",
          path: "guides/meta.json",
          data: {
            title: "Guides",
            icon: "guides",
            pages: ["overview", "advanced"],
          },
        },
        {
          type: "page",
          path: "guides/overview.mdx",
          data: { title: "Overview", icon: "overview" },
        },
        {
          type: "meta",
          path: "guides/advanced/meta.json",
          data: { title: "Advanced", icon: "advanced" },
        },
        {
          type: "page",
          path: "guides/advanced/index.mdx",
          data: { title: "Advanced", icon: "advanced" },
        },
        {
          type: "page",
          path: "guides/advanced/setup.mdx",
          data: { title: "Setup", icon: "setup" },
        },
      ],
    },
    pageTree: { transformers: [docsPageTreeTransformer] },
    icon: (name) =>
      name ? createElement("svg", { "data-icon": name }) : undefined,
  })
  const tree = source.getPageTree()
  const pages: string[] = []
  function inspect(node: Root | Node, depth = 0) {
    expect(Object.getOwnPropertySymbols(node)).toEqual([])
    if (node.type === "root" || node.type === "folder") {
      expect(Object.getOwnPropertySymbols(node.children)).toEqual([])
      if (node.type === "folder") {
        expect(isValidElement(node.icon)).toBe(true)
        if (node.index) {
          expect(Object.getOwnPropertySymbols(node.index)).toEqual([])
          expect(isValidElement(node.index.icon)).toBe(true)
        }
      }
      for (const child of node.children) inspect(child, depth + 1)
    } else if (node.type === "page") {
      pages.push(node.url)
      if (depth === 1) expect(isValidElement(node.icon)).toBe(true)
      else expect(node.icon).toBeUndefined()
    }
  }
  inspect(tree)
  expect(pages).toEqual([
    "/docs",
    "/docs/guides/overview",
    "/docs/guides/advanced/setup",
  ])
})
