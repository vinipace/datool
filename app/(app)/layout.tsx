import "../globals.css"
import { Inter, Geist_Mono } from "next/font/google"
import { rootMetadata } from "@/lib/page-metadata"
import { Toaster } from "@/components/ui/toast"

export const metadata = rootMetadata

const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" })

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
})

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      className={`dark ${inter.variable} ${geistMono.variable}`}
      lang="en"
      style={{ colorScheme: "dark" }}
    >
      <body className="font-sans antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  )
}
