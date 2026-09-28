export type DatasetItemTab = "form" | "runs" | "views"
export type DatasetItemLocation = {
  itemId: string | null
  tab: DatasetItemTab
  viewId: string | null
}

export function readDatasetItemLocation(pathname: string, params: URLSearchParams): DatasetItemLocation {
  const segment = pathname.match(/^\/p\/[^/]+\/datasets\/[^/]+\/([^/]+)\/?$/)?.[1]
  let itemId: string | null = null
  try { itemId = segment ? decodeURIComponent(segment) : null } catch { /* Invalid path encoding has no item. */ }
  const tab = params.get("itemTab")
  return {
    itemId,
    tab: tab === "runs" || tab === "views" ? tab : "form",
    viewId: params.get("objectView") || null,
  }
}

export function writeDatasetItemLocation(datasetPath: string, params: URLSearchParams, location: DatasetItemLocation) {
  const next = new URLSearchParams(params)
  next.delete("item")
  if (location.itemId) {
    next.set("itemTab", location.tab)
    if (location.viewId) next.set("objectView", location.viewId)
    else next.delete("objectView")
  } else {
    next.delete("itemTab")
    next.delete("objectView")
  }
  return {
    pathname: location.itemId ? `${datasetPath}/${encodeURIComponent(location.itemId)}` : datasetPath,
    search: next.toString(),
  }
}
