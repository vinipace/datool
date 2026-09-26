/** Shared URL contract for carrying a trace selection into the scorer editor. */
export function parseScorerTraceIds(value?: string | string[]): string[] {
  return [
    ...new Set(
      (Array.isArray(value) ? value : [value ?? ""])
        .flatMap((part) => part.split(","))
        .map((id) => id.trim())
        .filter(Boolean)
    ),
  ]
}

export function scorerTraceUrl(traceIds: string[]): string {
  const query = new URLSearchParams()
  if (traceIds.length) query.set("traceIds", [...new Set(traceIds)].join(","))
  return `/scorers/new${query.size ? `?${query}` : ""}`
}
