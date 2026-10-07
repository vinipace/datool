import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { FileText } from "lucide-react"
import defaultMdxComponents from "fumadocs-ui/mdx"
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/page"
import { Button } from "@/components/ui/button"
import { docsMarkdownUrl, docsSource } from "@/lib/docs-source"
import { socialPreviewImage } from "@/lib/page-metadata"

export const dynamic = "force-static"
export const dynamicParams = false

export function generateStaticParams() {
  return docsSource.generateParams()
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug?: string[] }>
}): Promise<Metadata> {
  const { slug } = await params
  const page = docsSource.getPage(slug)
  if (!page) notFound()
  return {
    title: page.data.title,
    description: page.data.description,
    alternates: { types: { "text/markdown": docsMarkdownUrl(page.slugs) } },
    openGraph: {
      title: `${page.data.title} · Datool`,
      description: page.data.description,
      type: "article",
      images: [socialPreviewImage],
    },
  }
}

export default async function DocumentationPage({
  params,
}: {
  params: Promise<{ slug?: string[] }>
}) {
  const { slug } = await params
  const page = docsSource.getPage(slug)
  if (!page) notFound()
  const Content = page.data.body

  return (
    <DocsPage toc={page.data.toc}>
      <div className="flex items-start justify-between gap-4">
        <DocsTitle className="min-w-0">{page.data.title}</DocsTitle>
        <Button
          asChild
          variant="ghost-muted"
          size="sm"
          className="mt-1 max-sm:size-8 max-sm:p-0"
        >
          <Link
            href={docsMarkdownUrl(page.slugs)}
            prefetch={false}
            aria-label="View as Markdown"
            title="View as Markdown"
          >
            <FileText aria-hidden="true" />
            <span className="hidden sm:inline">View as Markdown</span>
          </Link>
        </Button>
      </div>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <Content components={defaultMdxComponents} />
      </DocsBody>
    </DocsPage>
  )
}
