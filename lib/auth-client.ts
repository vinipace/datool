"use client"

import { createAuthClient } from "better-auth/react"
import { oauthProviderClient } from "@better-auth/oauth-provider/client"
import { magicLinkClient, organizationClient } from "better-auth/client/plugins"

export const authClient = createAuthClient({
  plugins: [organizationClient(), oauthProviderClient(), magicLinkClient()],
})
