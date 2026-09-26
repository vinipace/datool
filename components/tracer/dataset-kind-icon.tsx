import { Database, Folder, FolderOpen } from "lucide-react"

export function DatasetKindIcon({
  kind,
  expanded = false,
}: {
  kind: "folder" | "dataset"
  expanded?: boolean
}) {
  const Icon = kind === "dataset" ? Database : expanded ? FolderOpen : Folder
  return (
    <Icon
      className={
        kind === "folder"
          ? "fill-resource-folder-foreground text-resource-folder-foreground"
          : "text-resource-dataset-foreground"
      }
    />
  )
}
