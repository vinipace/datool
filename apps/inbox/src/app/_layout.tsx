import { useEffect, useRef } from "react"
import { AppState } from "react-native"
import { Stack } from "expo-router/stack"
import { router, type ErrorBoundaryProps } from "expo-router"
import { DarkTheme, ThemeProvider } from "expo-router/react-navigation"
import { StatusBar } from "expo-status-bar"
import { KeyboardProvider } from "react-native-keyboard-controller"
import { focusManager, useIsRestoring } from "@tanstack/react-query"
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client"
import * as Notifications from "expo-notifications"
import * as Network from "expo-network"
import { onlineManager } from "@tanstack/react-query"
import { queryClient } from "../lib/query"
import { useSession } from "../lib/session"
import { ticketDestination, refreshSubscriptions } from "../lib/notifications"
import { State } from "../components/ui"
import { persister, syncOutbox, useOnline } from "../lib/offline"
import colors from "../theme.generated.json"
import { flushDiagnostics, reportError } from "../lib/diagnostics"

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  useEffect(() => { reportError("render", error) }, [error])
  return <State title="Something went wrong" description="Please try opening this screen again." retry={retry} />
}

function Navigation() {
  const restoring = useIsRestoring()
  const online = useOnline()
  const session = useSession()
  const pending = useRef<ReturnType<typeof ticketDestination>>(null)
  const signedIn = Boolean(session.data)
  const ready = useRef(signedIn)
  useEffect(() => { ready.current = signedIn }, [signedIn])
  useEffect(() => {
    const userId = session.data?.user.id
    if (!userId || !online || restoring) return
    const sync = () => { if (AppState.currentState === "active") void syncOutbox(userId).catch(() => queryClient.invalidateQueries({ queryKey: ["outbox"] })) }
    sync()
    const timer = setInterval(sync, 5000)
    const app = AppState.addEventListener("change", state => { if (state === "active") sync() })
    return () => { clearInterval(timer); app.remove() }
  }, [session.data?.user.id, online, restoring])
  useEffect(() => {
    if (process.env.EXPO_OS === "web") return
    const open = (response: Notifications.NotificationResponse | null) => {
      const target = ticketDestination(response?.notification.request.content.data)
      if (!target) return
      pending.current = target
      if (ready.current) {
        router.push({ pathname: "/ticket/[projectId]/[ticketId]", params: target })
        pending.current = null
        void Notifications.clearLastNotificationResponseAsync()
      }
    }
    void Notifications.getLastNotificationResponseAsync().then(open)
    const listener = Notifications.addNotificationResponseReceivedListener(open)
    const received = Notifications.addNotificationReceivedListener(() => void queryClient.invalidateQueries({ queryKey: ["inbox"] }))
    return () => { listener.remove(); received.remove() }
  }, [])
  useEffect(() => {
    if (!signedIn || process.env.EXPO_OS === "web") return
    const refresh = () => { void refreshSubscriptions().catch(() => queryClient.invalidateQueries({ queryKey: ["devices"] })) }
    refresh()
    const app = AppState.addEventListener("change", state => { if (state === "active") refresh() })
    const tokens = Notifications.addPushTokenListener(refresh)
    return () => { app.remove(); tokens.remove() }
  }, [signedIn])
  useEffect(() => {
    if (!signedIn || !pending.current) return
    const target = pending.current
    pending.current = null
    router.push({ pathname: "/ticket/[projectId]/[ticketId]", params: target })
    void Notifications.clearLastNotificationResponseAsync()
  }, [signedIn])
  if (restoring) return <State loading title="Restoring saved inbox" />
  if (session.isPending) return <State loading={online} title="Connect to sign in" description={online ? undefined : "Sign in once while online to save your inbox on this phone."} />
  if (session.error && !session.data) return <State title="Could not connect" error={session.error} retry={() => void session.refetch()} />
  return <Stack screenOptions={{ headerStyle: { backgroundColor: colors.background }, headerTintColor: colors.foreground, contentStyle: { backgroundColor: colors.background }, headerShadowVisible: false }}>
    <Stack.Screen name="auth-callback" options={{ title: "Sign in" }} />
    <Stack.Protected guard={!signedIn}>
      <Stack.Screen name="sign-in" options={{ title: "Datool Inbox", headerShown: false }} />
      <Stack.Screen name="sign-in-email" options={{ title: "Sign in with email", headerShown: false }} />
    </Stack.Protected>
    <Stack.Protected guard={signedIn}>
      <Stack.Screen name="index" options={{ title: "Your workspaces" }} />
      <Stack.Screen name="inbox/[projectId]" options={{ title: "Inbox", headerShown: false }} />
      <Stack.Screen name="ticket/[projectId]/[ticketId]" options={{ title: "Conversation" }} />
      <Stack.Screen name="contact/[projectId]/[ticketId]" options={{ title: "Contact info", headerShown: false }} />
      <Stack.Screen name="settings" options={{ title: "Account", presentation: "modal", headerShown: false }} />
      <Stack.Screen name="outbox" options={{ title: "Outbox", headerShown: false }} />
    </Stack.Protected>
  </Stack>
}
export default function Layout() {
  useEffect(() => {
    void flushDiagnostics()
    const timer = setInterval(() => { if (AppState.currentState === "active") void flushDiagnostics() }, 30_000)
    const network = onlineManager.subscribe(online => { if (online) void flushDiagnostics() })
    const app = AppState.addEventListener("change", state => { if (state === "active") void flushDiagnostics() })
    return () => { clearInterval(timer); network(); app.remove() }
  }, [])
  useEffect(() => {
    const updateNetwork = (state: Network.NetworkState) => onlineManager.setOnline(state.isConnected !== false && state.isInternetReachable !== false)
    const refreshNetwork = () => { void Network.getNetworkStateAsync().then(updateNetwork).catch(() => { /* Keep the last known state if the native probe fails. */ }) }
    const app = AppState.addEventListener("change", state => {
      if (state === "active") refreshNetwork()
      focusManager.setFocused(state === "active")
    })
    const network = Network.addNetworkStateListener(updateNetwork)
    refreshNetwork()
    return () => { app.remove(); network.remove() }
  }, [])
  return <PersistQueryClientProvider client={queryClient} persistOptions={{ persister, maxAge: 7 * 86400_000, buster: "inbox-v1", dehydrateOptions: { shouldDehydrateMutation: () => false,
    shouldDehydrateQuery: query => !["outbox", "devices", "auth-config", "auth-notice"].includes(String(query.queryKey[0])) && query.state.data !== undefined,
  } }}><ThemeProvider value={{ ...DarkTheme, colors: { ...DarkTheme.colors, background: colors.background, card: colors.surface, text: colors.foreground, border: colors.border, primary: colors.primary } }}><KeyboardProvider><StatusBar style="light" /><Navigation /></KeyboardProvider></ThemeProvider></PersistQueryClientProvider>
}
