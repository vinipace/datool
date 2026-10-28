export type Page<T> = { items: T[]; nextCursor: string | null }
export type Project = { id: string; name: string; organizationName: string }
export type Agent = { id: string; name: string }
export type Ticket = {
  id: string; projectId: string; conversationId: string; subject: string; contactId?: string | null; contactName: string | null;
  channel: string; status: "open" | "pending" | "snoozed" | "solved" | "closed";
  priority: string; assigneeUserId: string | null; assigneeName: string | null;
  teamName: string | null; updatedAt: string; version: number;
}
export type Contact = { id: string; displayName: string; email: string | null; phone: string | null }
export type Message = { id: string; ordinal: number; role: string; content: unknown; createdAt: string;
  metadata: Record<string, unknown>; author: { name: string } | null }
export type Ownership = { mode: "ai" | "human"; ownerUserId: string | null; leaseExpiresAt: string | null; leaseToken: string | null; version: number }
export function messageText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map(messageText).filter(Boolean).join("\n")
  if (content && typeof content === "object") {
    const part = content as Record<string, unknown>
    if (typeof part.text === "string") return part.text
    if (part.type === "image") return "[Image]"
    if (part.type === "file") return `[Attachment: ${typeof part.name === "string" ? part.name : "file"}]`
    if (part.type === "widget") return "[Interactive widget — view in the web inbox]"
  }
  return ""
}
