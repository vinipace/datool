import type { ProjectSourceCollector } from "@datool/sdk/deploy"

// Replace this sample with a public API request through context.fetch(url).
// A collector returns documents; publication indexes them alongside Markdown.
const collect: ProjectSourceCollector = async () => [
  {
    path: "project-handbook.md",
    title: "Project handbook",
    text: "Active projects have status active. Archived projects are retained for reference.",
  },
]
export default collect
