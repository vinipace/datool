import { Inter, Geist_Mono } from "next/font/google"
import { Toaster } from "@/components/ui/toast"

const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" })

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
})

// Shared by every root layout; the product is dark, agent landings are light.
export function Document({
  theme,
  children,
}: Readonly<{
  theme: "dark" | "light"
  children: React.ReactNode
}>) {
  return (
    <html
      className={`${theme} ${inter.variable} ${geistMono.variable}`}
      lang="en"
      style={{ colorScheme: theme }}
    >
      <body className="font-sans antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  )
}
