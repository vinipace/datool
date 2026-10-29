export function chatDate(value: string, now = new Date()) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ""
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday"
  if (now.getTime() - date.getTime() < 6 * 86400_000) return date.toLocaleDateString(undefined, { weekday: "short" })
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" as const } : {}) })
}
