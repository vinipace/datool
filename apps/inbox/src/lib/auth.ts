import { createAuthClient } from "better-auth/react"
import { magicLinkClient } from "better-auth/client/plugins"
import { expoClient } from "@better-auth/expo/client"
import * as SecureStore from "expo-secure-store"
import { API_URL } from "./server-url"
export { API_URL, assertApiUrl } from "./server-url"

export const auth = createAuthClient({
  baseURL: API_URL || undefined,
  fetchOptions: { timeout: 20_000 },
  plugins: [magicLinkClient(), expoClient({ scheme: "datool-inbox", storagePrefix: "datool-inbox", storage: SecureStore })],
})
