import "../globals.css"
import { rootMetadata } from "@/lib/page-metadata"
import { Document } from "@/app/document"

export const metadata = rootMetadata

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return <Document theme="dark">{children}</Document>
}
