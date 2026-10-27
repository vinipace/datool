import type { MetadataRoute } from "next"
import { publicOrigin } from "@/lib/public-origin"

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/cms/", "/p/", "/chat/", "/share/", "/cms-preview"],
    },
    sitemap: `${publicOrigin()}/sitemap.xml`,
  }
}
