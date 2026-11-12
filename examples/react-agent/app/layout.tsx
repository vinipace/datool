/* eslint-disable react-refresh/only-export-components -- Next.js layouts also export page metadata. */
import type { ReactNode } from "react"
import "@datool/react/styles.css"
import "./globals.css"
export const metadata = {
  title: "Datool · Agent workspace",
  description:
    "A local React SDK playground for chat, files, and proactive tasks.",
}
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
