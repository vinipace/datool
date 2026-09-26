import type { ReactNode } from "react"
import Image from "next/image"
import { DocsLayout } from "fumadocs-ui/layouts/docs"
import { DocsProvider } from "@/components/docs/provider"
import { DocsHeader } from "@/components/docs/header"
import { docsSource } from "@/lib/docs-source"
import RootLayout from "@/app/(app)/layout"

export { metadata } from "@/app/(app)/layout"

export default function DocumentationLayout({
  children,
}: {
  children: ReactNode
}) {
  return (
    <RootLayout>
      <DocsProvider>
        <DocsLayout
          tree={docsSource.getPageTree()}
          slots={{ header: DocsHeader }}
          nav={{
            title: (
              <>
                <Image
                  src="/icon.svg"
                  alt=""
                  width={20}
                  height={20}
                  unoptimized
                  className="size-5 shrink-0"
                />
                <span className="font-semibold tracking-tight">
                  Datool{" "}
                  <span className="ml-2 font-normal text-foreground-muted">
                    Docs
                  </span>
                </span>
              </>
            ),
            url: "/docs",
          }}
          links={[{ text: "Open Datool", url: "/", type: "button" }]}
          themeSwitch={{ enabled: false }}
          sidebar={{ defaultOpenLevel: 1 }}
          containerProps={{ className: "datool-docs" }}
        >
          {children}
        </DocsLayout>
      </DocsProvider>
    </RootLayout>
  )
}
