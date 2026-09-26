import type { Folder } from "fumadocs-core/page-tree"

export const docsPageTreeTransformer = {
  folder(node: Folder, folderPath: string) {
    if (!folderPath) return node
    // Fumadocs removes its internal symbols from these same nodes after building.
    // Cloning a child here would leave the copy outside that cleanup.
    for (const child of node.children) {
      if (child.type === "page") child.icon = undefined
    }
    return node
  },
}
