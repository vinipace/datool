import { useEffect, useRef, useState } from "react"
import { router, useLocalSearchParams } from "expo-router"
import * as SecureStore from "expo-secure-store"
import { getSetCookie, storageAdapter } from "@better-auth/expo/client"
import { auth } from "../lib/auth"
import { queryClient } from "../lib/query"
import { State } from "../components/ui"
import { reportError } from "../lib/diagnostics"

export default function AuthCallback() {
  const { state, cookie } = useLocalSearchParams<{ state: string; cookie: string }>()
  const [error, setError] = useState<Error | null>(null)
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    async function finish() {
      const saved = await SecureStore.getItemAsync("datool-inbox-email-state")
      const pending = saved ? JSON.parse(saved) : null
      if (!pending || pending.state !== state || pending.expires < Date.now() || typeof cookie !== "string" || cookie.length > 16000) throw Object.assign(new Error("This sign-in link expired or belongs to another device. Request a new link."), { code: "INVALID_CALLBACK" })
      await SecureStore.deleteItemAsync("datool-inbox-email-state")
      await storageAdapter(SecureStore).setItemAsync("datool-inbox_cookie", getSetCookie(cookie))
      const result = await auth.getSession({ query: { disableCookieCache: true } })
      if (!result.data || result.error) throw new Error("The sign-in link could not be verified.")
      await queryClient.cancelQueries()
      queryClient.removeQueries({ predicate: query => query.queryKey[0] !== "session" })
      queryClient.setQueryData(["session"], { user: { id: result.data.user.id, name: result.data.user.name, email: result.data.user.email } })
      router.replace("/")
    }
    void finish().catch(error => { reportError("email_callback", error); setError(error) })
  }, [state, cookie])
  return <State loading={!error} title="Unable to sign in" error={error} retry={() => router.replace("/sign-in")} />
}
