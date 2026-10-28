type GroupableMessage = {
  role: string
  createdAt?: string
  metadata?: Record<string, unknown>
  author?: { key?: string } | null
}

/** Only adjacent messages with known times and the same sender form a group. */
export function sameChatMessageGroup(
  previous: GroupableMessage | undefined,
  next: GroupableMessage | undefined
): boolean {
  if (!previous?.createdAt || !next?.createdAt) return false
  if (previous.role !== next.role) return false
  const minute = (date: string) => Math.floor(Date.parse(date) / 60_000)
  if (minute(previous.createdAt) !== minute(next.createdAt)) return false
  const previousHuman = previous.metadata?.source === "human"
  const nextHuman = next.metadata?.source === "human"
  if (previousHuman !== nextHuman) return false
  return previousHuman
    ? Boolean(previous.author?.key && previous.author.key === next.author?.key)
    : previous.role === "user" || previous.role === "assistant"
}
