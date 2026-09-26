import { docsMarkdown, docsSource } from "@/lib/docs-source"
import { markdownNotFound } from "@/lib/markdown-negotiation"

export const dynamic = "force-static"

export function generateStaticParams() {
  return docsSource.generateParams()
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug?: string[] }> }
) {
  const { slug } = await params
  const page = docsSource.getPage(slug)
  if (!page) return markdownNotFound()
  return new Response(await docsMarkdown(page), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      Vary: "Accept",
    },
  })
}
