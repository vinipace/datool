import type { AuthStrategy } from "payload"
import { getAuth } from "@/lib/auth"
import { isAllowedEditor } from "./access"

// Payload users are editorial identities linked to the existing Better Auth session.
// Public signup, password login, and Payload JWT login are disabled.
export const betterAuthStrategy: AuthStrategy = {
  name: "datool-session",
  authenticate: async ({ headers, payload }) => {
    if (!process.env.CMS_ADMIN_USER_IDS?.trim() || !headers.get("cookie"))
      return { user: null }
    const origin = headers.get("origin")
    if (origin && origin !== new URL(process.env.BETTER_AUTH_URL!).origin)
      return { user: null }
    const session = await getAuth().api.getSession({ headers })
    if (!session?.user.emailVerified || !isAllowedEditor(session.user.id))
      return { user: null }
    const identity = session.user
    const findLinked = async () =>
      (
        await payload.find({
          collection: "cms-users",
          overrideAccess: true,
          depth: 0,
          limit: 1,
          where: { authUserId: { equals: identity.id } },
        })
      ).docs[0]
    let user = await findLinked()
    if (!user) {
      try {
        user = await payload.create({
          collection: "cms-users",
          overrideAccess: true,
          data: {
            authUserId: identity.id,
            email: identity.email,
            name: identity.name,
          },
        })
      } catch (error) {
        // Concurrent first visits may provision the same verified identity.
        user = await findLinked()
        if (!user) throw error
      }
    }
    return {
      user: { ...user, collection: "cms-users", _strategy: "datool-session" },
    }
  },
}
