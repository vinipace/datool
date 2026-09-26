import type { SerializedLinkNode } from "@payloadcms/richtext-lexical"
import { getPagePath } from "../lib/cms/page-path"

export function internalDocToHref({
  linkNode,
}: {
  linkNode: SerializedLinkNode
}): string {
  const doc = linkNode.fields.doc
  const value = doc?.value
  if (
    !value ||
    typeof value !== "object" ||
    !("slug" in value) ||
    typeof value.slug !== "string" ||
    !("_status" in value) ||
    value._status !== "published"
  )
    return "#"
  if (doc.relationTo === "pages") return getPagePath(value.slug)
  if (doc.relationTo === "faqs") return `/faq/${encodeURIComponent(value.slug)}`
  return "#"
}
