export const dynamic = "force-dynamic"
export function GET() {
  return Response.json(
    {
      emailLink:
        authEmailConfigured() &&
        Boolean(
          process.env.AUTH_ALLOW_PUBLIC_SIGNUP === "true" || process.env.AUTH_ALLOWED_DOMAINS?.split(",").some((domain) =>
            domain.trim()
          )
        ),
      google: Boolean(
        process.env.GOOGLE_CLIENT_ID &&
        process.env.GOOGLE_CLIENT_SECRET &&
        (process.env.AUTH_ALLOW_PUBLIC_SIGNUP === "true" ||
          process.env.AUTH_ALLOWED_DOMAINS?.split(",").some((domain) =>
            domain.trim()
          ))
      ),
    },
    { headers: { "Cache-Control": "no-store" } }
  )
}
import { authEmailConfigured } from "@/src/server/auth/email"
