import type { FieldHook } from "payload"
import type { Faq } from "@/payload-types"
import { FAQ_SKIP_RELATED_PAGES_CONTEXT, pageUsesFAQ } from "@/lib/cms/faq"

// Derived from page blocks, like blog-2. The context guard prevents recursive
// FAQ -> page -> FAQ reads without bypassing the caller's access permissions.
export const populateFAQRelatedPages: FieldHook<
  Faq,
  Faq["relatedPages"]
> = async ({ context, draft, req, siblingData }) => {
  if (context[FAQ_SKIP_RELATED_PAGES_CONTEXT] || !siblingData.id) return []
  const result = await req.payload.find({
    collection: "pages",
    depth: 0,
    draft,
    overrideAccess: false,
    req,
    pagination: false,
    context: { ...context, [FAQ_SKIP_RELATED_PAGES_CONTEXT]: true },
  })
  return result.docs.filter((page) => pageUsesFAQ(page, siblingData.id))
}
