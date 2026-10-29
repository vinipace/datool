import { useEffect } from "react"
import { Text, View, useWindowDimensions } from "react-native"
import { router, useLocalSearchParams } from "expo-router"
import { skipToken, useQuery, useMutation } from "@tanstack/react-query"
import { auth } from "../lib/auth"
import { request } from "../lib/api"
import { queryClient } from "../lib/query"
import { useOnline } from "../lib/offline"
import { AuthButton, AuthFeedback, AuthScreen } from "../components/auth-screen"
import { authStyles } from "../components/auth-styles"
import { reportError } from "../lib/diagnostics"

export default function SignIn() {
  const notice = useQuery<string>({ queryKey: ["auth-notice"], queryFn: skipToken })
  const { error: callbackError } = useLocalSearchParams<{ error?: string }>()
  const callbackMessage = !callbackError ? null : ["state_mismatch", "state_not_found", "invalid_state"].includes(callbackError)
    ? "Google sign-in expired. Please try again."
    : callbackError === "access_denied" ? "Google sign-in was cancelled. You can try again."
    : "Google sign-in couldn’t finish. Please try again."
  useEffect(() => {
    if (callbackError) reportError("google_sign_in", { code: callbackError })
  }, [callbackError])
  const { width } = useWindowDimensions()
  const online = useOnline()
  const headlineSize = Math.min(62, (width - 52) * 0.165)
  // This public read must remain retryable even when connectivity reporting is
  // stale after a Wi-Fi/cellular handoff. The request has a bounded timeout.
  const config = useQuery({ queryKey: ["auth-config"], networkMode: "always", retry: false,
    queryFn: ({ signal }) => request<{ google: boolean; emailLink: boolean }>("/api/auth/config", { signal, credentials: "omit" }) })
  const google = useMutation({ networkMode: "always", mutationFn: async () => {
    let stage = "google_sign_in" as "google_sign_in" | "google_session"
    try {
      const result = await auth.signIn.social({ provider: "google", callbackURL: "/", errorCallbackURL: "/sign-in" })
      if (result.error) throw Object.assign(new Error(result.error.message || "Google sign-in couldn’t finish. Please try again."), { code: result.error.code, status: result.error.status })
      // Native social login resolves even if Safari closes without a session.
      // A successful web start navigates away; verification belongs to that return.
      if (process.env.EXPO_OS !== "web") {
        stage = "google_session"
        // Discard any anonymous session read started while Safari was open.
        await queryClient.cancelQueries({ queryKey: ["session"] })
        const session = await auth.getSession({ query: { disableCookieCache: true } })
        if (session.error) throw Object.assign(new Error("Could not verify your sign-in. Please try again."), { code: session.error.code, status: session.error.status })
        if (!session.data) throw Object.assign(new Error("Google sign-in didn’t finish. Please try again and complete the steps in your browser."), { code: "SESSION_MISSING" })
        const { id, name, email, image } = session.data.user
        queryClient.removeQueries({ queryKey: ["auth-notice"], exact: true })
        queryClient.setQueryData(["session"], { user: { id, name, email, image } })
      } else {
        await queryClient.invalidateQueries({ queryKey: ["session"] })
      }
    } catch (error) { reportError(stage, error); throw error }
  } })
  return <AuthScreen>
    <View style={authStyles.story}>
      <Text accessibilityRole="header" style={[authStyles.headline, { fontSize: headlineSize, lineHeight: headlineSize * 1.02 }]}>{"BE THERE.\nWHEN IT\nMATTERS."}</Text>
      <Text style={authStyles.description}>Great support starts with a human. Pick up the conversation, wherever you are.</Text>
    </View>
    <View style={authStyles.actions}>
      {!config.data && !online ? <AuthFeedback message="You’re offline. Connect to the internet to sign in." /> : config.isLoading ? <AuthFeedback loading message="Getting sign-in options…" /> : config.error ? <AuthFeedback error message="We couldn’t connect to Datool. Check your connection and try again." /> : null}
      {!config.data && (!online || config.error) && <AuthButton title="Try again" icon="retry" loading={config.isFetching} onPress={() => void config.refetch()} />}
      {(google.error || callbackMessage) && <AuthFeedback error message={google.error?.message ?? callbackMessage!} />}
      {!google.error && !callbackMessage && notice.data && <AuthFeedback error message={notice.data} />}
      {config.data?.emailLink && <AuthButton title="Continue with email" icon="mail" disabled={google.isPending} onPress={() => { google.reset(); router.push("/sign-in-email") }} />}
      {config.data?.google && <AuthButton title={google.isPending ? "Connecting to Google…" : "Continue with Google"} google loading={google.isPending} onPress={() => { router.setParams({ error: undefined }); google.mutate() }} />}
      {config.data && !config.data.google && !config.data.emailLink && <AuthFeedback message="Sign-in isn’t available yet. Ask your Datool administrator to enable Google or email sign-in." />}
    </View>
    <Text style={authStyles.footer}>Sign in with your team’s Datool account.</Text>
  </AuthScreen>
}
