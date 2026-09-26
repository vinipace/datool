/** Dashed guides are presentation only; missing observations stay null. */
export function dashboardChartGaps(
  rows: Record<string, unknown>[],
  keys: string[]
) {
  const data = rows.map((row) => ({ ...row }))
  const gaps: { key: string; source: string }[] = []
  keys.forEach((source, seriesIndex) => {
    const values = rows.map((row) => {
      const value = row[source]
      return typeof value === "number" && Number.isFinite(value) ? value : null
    })
    values.forEach((value, index) => {
      data[index][source] = value
    })
    for (let start = 0; start < values.length; start++) {
      if (values[start] !== null) continue
      let end = start + 1
      while (end < values.length && values[end] === null) end++
      const left = start > 0 ? values[start - 1] : null
      const right = end < values.length ? values[end] : null
      if (left !== null || right !== null) {
        const key = `gap${seriesIndex}_${start}`
        gaps.push({ key, source })
        const first = left === null ? start : start - 1
        const last = right === null ? end - 1 : end
        for (let index = 0; index < data.length; index++) {
          data[index][key] =
            index < first || index > last
              ? null
              : left !== null && right !== null
                ? left + (right - left) * ((index - first) / (last - first))
                : (left ?? right)
        }
      }
      start = end - 1
    }
  })
  return { data, gaps }
}
