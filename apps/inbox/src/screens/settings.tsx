import { useRef, useState, type ComponentRef } from "react"
import { ScrollView, Text, TextInput, View, Linking } from "react-native"
import { router } from "expo-router"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useMutation, useQuery } from "@tanstack/react-query"
import { auth } from "../lib/auth"
import { api } from "../lib/api"
import { queryClient } from "../lib/query"
import { useSession } from "../lib/session"
import { installationId, subscribe, unsubscribe } from "../lib/notifications"
import { Action, ActionRow, Avatar, Copy, Field, Heading, IconButton, Notice, Sheet, State, TextAction } from "../components/ui"
import { styles } from "../components/styles"
import { outbox, persister, useOnline, useOutbox } from "../lib/offline"

type Panel = "profile" | "notifications" | "privacy" | null
export default function Settings({ tabbed = false, projectId }: { tabbed?: boolean; projectId?: string }) {
  const insets = useSafeAreaInsets()
  const session = useSession()
  const online = useOnline()
  const saved = useOutbox(session.data?.user.id)
  const pending = saved.data?.filter(reply => reply.status !== "submitted").length ?? 0
  const [panel, setPanel] = useState<Panel>(null)
  const [searching, setSearching] = useState(false)
  const [search, setSearch] = useState("")
  const searchInput = useRef<ComponentRef<typeof TextInput>>(null)
  const [name, setName] = useState("")
  const devices = useQuery({ queryKey: ["devices", session.data?.user.id], queryFn: async () => api<{ projectId: string }[]>(`/api/inbox-mobile/devices?installationId=${await installationId()}`) })
  const enabled = devices.data?.some(device => device.projectId === projectId) ?? false
  const notifications = useMutation({ mutationFn: (enable: boolean) => enable ? subscribe(projectId!) : unsubscribe(projectId), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["devices"] }) })
  const profile = useMutation({ mutationFn: async () => {
    const result = await auth.updateUser({ name: name.trim() })
    if (result.error) throw new Error(result.error.message || "Couldn’t save your name. Try again.")
  }, onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["session"] }); setPanel(null) } })
  const signOut = useMutation({ mutationFn: async () => {
    if (session.data?.user.id && (await outbox.list(session.data.user.id)).some(reply => reply.status !== "submitted")) throw new Error("Send or remove your queued replies before signing out.")
    await unsubscribe().catch(() => undefined)
    const result = await auth.signOut()
    if (result.error) throw new Error(result.error.message)
    await queryClient.cancelQueries()
    queryClient.removeQueries({ predicate: query => query.queryKey[0] !== "session" })
    queryClient.setQueryData(["session"], null)
    await persister.removeClient()
    if (session.data?.user.id) await outbox.clearSubmitted(session.data.user.id)
  } })
  function openProfile() { profile.reset(); setName(session.data?.user.name || ""); setPanel("profile") }
  function openOutbox() { router.navigate(projectId ? { pathname: "/inbox/[projectId]/outbox", params: { projectId } } : "/outbox") }
  const matches = (value: string) => value.toLowerCase().includes(search.trim().toLowerCase())
  const groups = [
    [
      { icon: "bell" as const, title: "Notifications", onPress: () => setPanel("notifications"), trailing: projectId ? <Text style={styles.quietCaption}>{devices.isPending ? "…" : devices.error ? "Unavailable" : enabled ? "On" : "Off"}</Text> : undefined },
      { icon: "outbox" as const, title: "Saved replies", onPress: openOutbox, trailing: pending ? <View style={styles.statusPill}><Text style={styles.statusLabel}>{pending}</Text></View> : undefined },
      { icon: "workspaces" as const, title: "Workspaces", onPress: () => router.navigate("/") },
    ],
    [
      { icon: "key" as const, title: "Account", onPress: openProfile },
      { icon: "shield" as const, title: "Privacy & offline access", onPress: () => setPanel("privacy") },
    ],
  ].map(rows => rows.filter(row => matches(row.title))).filter(rows => rows.length)
  return <View style={styles.screen}><View collapsable={false} style={[styles.frame, { paddingTop: insets.top }]}>
    <View style={styles.toolbar}>
      {tabbed ? <IconButton name="search" label="Search settings" onPress={() => { setSearching(true); searchInput.current?.focus() }} /> : <IconButton name="back" label="Back" onPress={() => { if (router.canGoBack()) router.back(); else router.replace("/") }} />}
      <IconButton name="edit" label="Edit profile" onPress={openProfile} />
    </View>
    {searching && <View style={[styles.inboxHeader, { flexDirection: "row", alignItems: "center", gap: 8 }]}><Field ref={searchInput} autoFocus accessibilityLabel="Search settings" placeholder="Search settings" value={search} onChangeText={setSearch} style={{ flex: 1 }} /><TextAction title="Cancel" onPress={() => { setSearching(false); setSearch("") }} /></View>}
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: tabbed && process.env.EXPO_OS === "web" ? 110 : 30, gap: 24 }} contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled">
      {!search.trim() && <View style={styles.accountHero}>
        <Avatar name={session.data?.user.name || "You"} identityKey={session.data?.user.id} imageUrl={session.data?.user.image} size={104} />
        <View style={{ alignItems: "center", gap: 4, maxWidth: "100%" }}><Text accessibilityRole="header" numberOfLines={2} style={styles.accountName}>{session.data?.user.name || "Your account"}</Text><Text selectable numberOfLines={1} style={[styles.quietCaption, { fontSize: 15, lineHeight: 20 }]}>{session.data?.user.email}</Text></View>
      </View>}
      {groups.map((rows, groupIndex) => <View key={groupIndex} style={styles.accountGroup}>{rows.map((row, index) => <View key={row.title}>{index > 0 && <View style={styles.divider} />}<ActionRow {...row} /></View>)}</View>)}
      {!groups.length && <State icon="search" title="No settings found" description="Try notifications, account, or saved replies." />}
      {!search.trim() && <View style={styles.section}><View style={styles.accountGroup}><ActionRow icon="logout" title={signOut.isPending ? "Signing out…" : "Sign out"} trailing={false} destructive disabled={!online || signOut.isPending || notifications.isPending || pending > 0 || saved.isPending || !!saved.error} onPress={() => signOut.mutate()} /></View>{pending > 0 && <Text style={[styles.quietCaption, { paddingHorizontal: 8 }]}>Send or remove your saved replies before signing out.</Text>}<Notice error={signOut.error ?? saved.error} /></View>}
    </ScrollView>
  </View>
    <Sheet open={panel === "profile"} onClose={() => { if (!profile.isPending) setPanel(null) }}>
      <Heading>Your profile</Heading><Copy muted>Your name is visible to your team.</Copy>
      <Field accessibilityLabel="Your name" placeholder="Your name" value={name} onChangeText={setName} maxLength={100} editable={!profile.isPending} autoCapitalize="words" />
      <Copy muted>{session.data?.user.email}</Copy><Notice error={profile.error} />
      <Action title={profile.isPending ? "Saving…" : "Save changes"} disabled={!online || profile.isPending || !name.trim() || name.trim() === session.data?.user.name} onPress={() => profile.mutate()} />
      {!online && <Copy muted>Reconnect to update your profile.</Copy>}<TextAction title="Cancel" disabled={profile.isPending} onPress={() => setPanel(null)} />
    </Sheet>
    <Sheet open={panel === "notifications"} onClose={() => setPanel(null)}><Heading>Handoff notifications</Heading><Copy muted>Get notified about your assignments, handoffs to your team, and unassigned conversations in this workspace.</Copy><Copy muted>Customer messages stay off your lock screen.</Copy><Notice error={notifications.error ?? devices.error} />
      {process.env.EXPO_OS === "web" ? <Copy>Enable notifications from the app on your phone.</Copy> : projectId ? <><Action title={notifications.isPending ? "Updating…" : enabled ? "Turn off notifications" : "Enable notifications"} disabled={!online || notifications.isPending || devices.isPending || !!devices.error} onPress={() => notifications.mutate(!enabled)} /><TextAction title="Phone notification settings" onPress={() => void Linking.openSettings()} /></> : <Copy>Choose a workspace to set up alerts.</Copy>}
      {devices.error && <TextAction title="Retry subscription status" onPress={() => void devices.refetch()} />}<TextAction title="Done" onPress={() => setPanel(null)} />
    </Sheet>
    <Sheet open={panel === "privacy"} onClose={() => setPanel(null)}><Heading>Privacy & offline access</Heading><Copy>Conversations you’ve opened are saved on this phone so you can read and reply offline.</Copy><Copy muted>Replies stay in Outbox until submitted. Sync runs while the app is open and connected.</Copy><Copy muted>Conversation storage isn’t encrypted by this app. Signing out clears saved conversations; removing the app also removes unsent replies.</Copy><TextAction title="View saved replies" onPress={() => { setPanel(null); openOutbox() }} /><TextAction title="Done" onPress={() => setPanel(null)} /></Sheet>
  </View>
}
