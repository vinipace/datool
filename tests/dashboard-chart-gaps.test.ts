import { expect, test } from "bun:test"
import { dashboardChartGaps } from "@/src/lib/tracer/dashboard-chart-gaps"

test("bridges each missing run separately without changing observations", () => {
  const values = [null, 2, null, null, 8, 10, null, 0, null]
  const rows = values.map((value, index) => ({ date: index, value }))
  const { data, gaps } = dashboardChartGaps(rows, ["value"])
  expect(data.map((row) => row.value)).toEqual(values)
  expect(rows).toEqual(values.map((value, index) => ({ date: index, value })))
  expect(gaps.map(({ key }) => data.map((row) => row[key]))).toEqual([
    [2, 2, null, null, null, null, null, null, null],
    [null, 2, 4, 6, 8, null, null, null, null],
    [null, null, null, null, null, 10, 5, 0, null],
    [null, null, null, null, null, null, null, 0, 0],
  ])
})

test("all-missing and complete series do not invent dashed values", () => {
  for (const values of [
    [],
    [null, null],
    [0, 0, 2],
    [NaN, undefined, Infinity],
  ]) {
    const result = dashboardChartGaps(
      values.map((value) => ({ value })),
      ["value"]
    )
    expect(result.gaps).toEqual([])
  }
})

test("each measure bridges its own gaps; zero is an observed value", () => {
  const { data, gaps } = dashboardChartGaps(
    [
      { a: 0, b: null },
      { a: null, b: 6 },
      { a: 4, b: null },
    ],
    ["a", "b"]
  )
  expect(gaps.map((gap) => gap.source)).toEqual(["a", "b", "b"])
  expect(data.map((row) => row[gaps[0].key])).toEqual([0, 2, 4])
  expect(data.map((row) => row[gaps[1].key])).toEqual([6, 6, null])
  expect(data.map((row) => row[gaps[2].key])).toEqual([null, 6, 6])
})
