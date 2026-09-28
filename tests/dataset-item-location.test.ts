import { describe, expect, test } from "bun:test"
import { readDatasetItemLocation, writeDatasetItemLocation } from "../src/lib/tracer/dataset-item-location"
import { applyPageViewQueryParams, pageViewPathname, pageViewQueryParams } from "../src/lib/tracer/view-resources"

const datasetPath = "/p/demo/datasets/dataset-one"

describe("dataset item links", () => {
  test("round trips the item path, tab and object view without changing table state", () => {
    const table = new URLSearchParams('filter=id+%3D+"case"&pageView=table-view&sort=desc')
    const location = { itemId: "item /?中文", tab: "views" as const, viewId: "project-view" }
    const url = writeDatasetItemLocation(datasetPath, table, location)
    const params = new URLSearchParams(url.search)
    expect(url.pathname).toBe(`${datasetPath}/item%20%2F%3F%E4%B8%AD%E6%96%87`)
    expect(params.has("item")).toBe(false)
    expect(readDatasetItemLocation(url.pathname, params)).toEqual(location)
    expect(params.get("filter")).toBe(table.get("filter"))
    expect(params.get("pageView")).toBe("table-view")
    expect(writeDatasetItemLocation(datasetPath, params, { ...location, itemId: null })).toEqual({
      pathname: datasetPath, search: table.toString(),
    })
  })
  test("unknown or missing tabs fall back to Form", () => {
    expect(readDatasetItemLocation(`${datasetPath}/one`, new URLSearchParams("itemTab=invalid")).tab).toBe("form")
    expect(readDatasetItemLocation(datasetPath, new URLSearchParams())).toEqual({ itemId: null, tab: "form", viewId: null })
    expect(readDatasetItemLocation(`${datasetPath}/one/`, new URLSearchParams()).itemId).toBe("one")
    expect(readDatasetItemLocation(`${datasetPath}/%E0%A4%A`, new URLSearchParams()).itemId).toBeNull()
  })
  test("item routes share the dataset table's Page View drafts", () => {
    expect(pageViewPathname(`${datasetPath}/one`)).toBe(datasetPath)
    expect(pageViewPathname(`${datasetPath}/two`)).toBe(datasetPath)
    expect(pageViewPathname(datasetPath)).toBe(datasetPath)
    expect(pageViewPathname("/p/demo/traces/one")).toBe("/p/demo/traces/one")
  })
  test("Page Views neither capture nor overwrite inspector selections", () => {
    const params = new URLSearchParams("itemTab=views&objectView=renderer&filter=hello&tab=results")
    expect(pageViewQueryParams(params)).toEqual({ filter: ["hello"], tab: ["results"] })
    expect(readDatasetItemLocation(`${datasetPath}/one`, applyPageViewQueryParams(params, { filter: ["new"] }))).toEqual({ itemId: "one", tab: "views", viewId: "renderer" })
  })
})
