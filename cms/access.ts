import type { Access } from "payload"

export function isAllowedEditor(
  id: unknown,
  allowlist = process.env.CMS_ADMIN_USER_IDS ?? ""
) {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    allowlist
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .includes(id)
  )
}

export function isEditor(user: unknown) {
  const editor = user as { collection?: string; authUserId?: string } | null
  return (
    editor?.collection === "cms-users" && isAllowedEditor(editor.authUserId)
  )
}

/** Cross-organization operational data is restricted beyond content editing. */
export function isSystemAdmin(user: unknown) {
  const editor = user as { authUserId?: string } | null
  return (
    isEditor(user) &&
    isAllowedEditor(editor?.authUserId, process.env.SYSTEM_ADMIN_USER_IDS ?? "")
  )
}

export const editorOnly: Access = ({ req }) => isEditor(req.user)
export const publishedOrEditor: Access = ({ req }) =>
  isEditor(req.user) || { _status: { equals: "published" } }

export function safeHref(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    /[\s\\]/.test(value) ||
    [...value].some((char) => char.charCodeAt(0) < 32)
  )
    return false
  if (/^\/(?!\/)/.test(value) || /^#[a-zA-Z][\w-]*$/.test(value)) return true
  try {
    const url = new URL(value)
    return (
      ["http:", "https:", "mailto:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}
