import { Inter, Geist_Mono } from "next/font/google"
import { Toaster } from "@/components/ui/toast"
import { ThemeSync } from "@/components/ui/theme"
import { SiteAnalytics } from "@/components/site-analytics"

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
})

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
})

// Shared roots: the product follows its saved appearance, marketing keeps its own theme.
export function Document({
  theme,
  children,
}: Readonly<{
  theme: "dark" | "light" | "system"
  children: React.ReactNode
}>) {
  return (
    <html
      className={`${theme === "system" ? "dark" : theme} ${inter.variable} ${geistMono.variable}`}
      suppressHydrationWarning={theme === "system"}
      lang="en"
      style={{ colorScheme: theme === "system" ? "dark" : theme }}
    >
      <head>
        {theme === "system" && (
          <script
            dangerouslySetInnerHTML={{
              __html: `(function(){try{var m=localStorage.getItem('datool:theme');var t=m==='light'||m==='dark'?m:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';var d=document.documentElement;d.classList.remove('light','dark');d.classList.add(t);d.style.colorScheme=t}catch(e){}})()`,
            }}
          />
        )}
      </head>
      <body className="font-sans antialiased">
        {theme === "system" && <ThemeSync />}
        {children}
        <Toaster />
        <SiteAnalytics />
      </body>
    </html>
  )
}
