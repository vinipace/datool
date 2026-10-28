import { useState } from "react"
import { FlatList, Text, View } from "react-native"
import { router } from "expo-router"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useMutation } from "@tanstack/react-query"
import { useSession } from "../lib/session"
import { queryClient } from "../lib/query"
import type { Ticket } from "../lib/types"
import { chatDate } from "../lib/format"
import { outbox, syncOutbox, useOnline, useOutbox } from "../lib/offline"
import { Action, Copy, Heading, IconButton, Notice, Sheet, State, TextAction } from "../components/ui"
import { PageHeader } from "../components/page-header"
import { Icon } from "../components/icons"
import { styles } from "../components/styles"
import colors from "../theme.generated.json"

export default function Outbox({ tabbed = false }: { tabbed?: boolean }) {
  const userId = useSession().data?.user.id
  const online = useOnline()
  const insets = useSafeAreaInsets()
  const replies = useOutbox(userId)
  const [removing, setRemoving] = useState<string | null>(null)
  const edit = useMutation({ networkMode: "always", mutationFn: async ({ id, remove }: { id: string; remove?: boolean }) => {
    if (!userId) return
    if (remove) await outbox.remove(userId, id)
    else { await outbox.retry(userId, id); if (online) await syncOutbox(userId) }
  }, onSuccess: () => setRemoving(null) })
  const items = replies.data?.filter(item => item.status !== "submitted") ?? []
  return <View style={styles.screen}><View collapsable={false} style={[styles.frame, { paddingTop: insets.top }]}>
    <PageHeader title="Outbox" back={!tabbed} />
    <FlatList style={styles.screen} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: tabbed && process.env.EXPO_OS === "web" ? 110 : 24, gap: 14 }} contentInsetAdjustmentBehavior="automatic"
      data={items} keyExtractor={item => item.id}
      ListHeaderComponent={<View style={{ gap: 12 }}>{items.length > 0 && <View style={styles.infoCard}><Icon name={online ? "shield" : "offline"} size={20} color={colors.muted} /><Text style={styles.infoCardText}>{online ? "Your replies are saved. Keep the app open while they send." : "Your replies are safe on this phone. Reopen the app when you’re connected to send them."}</Text></View>}<Notice error={replies.error ?? edit.error} /></View>}
      ListEmptyComponent={<State icon="check" loading={replies.isPending} title={replies.error ? "Couldn’t read saved replies" : "Nothing waiting to send"} description={replies.error ? "Your saved replies have been kept on this phone." : "You’re up to date. Replies you write offline will wait here until you’re connected."} retry={replies.error ? () => void replies.refetch() : undefined} />}
      renderItem={({ item }) => {
        const ticket = queryClient.getQueryData<Ticket>(["ticket", item.projectId, item.ticketId])
        return <View style={[styles.row, { gap: 12, paddingBottom: 8 }]}>
          <View style={styles.headerTitleRow}><Text style={[styles.chatName, { flex: 1 }]} numberOfLines={1}>{ticket?.contactName || ticket?.subject || "Customer conversation"}</Text><Text style={styles.quietCaption}>{chatDate(new Date(item.createdAt).toISOString())}</Text></View>
          <View style={[styles.statusPill, item.status === "blocked" && styles.warningPill]}><Icon name={item.status === "blocked" ? "info" : "clock"} size={13} color={item.status === "blocked" ? colors.warning : colors.selectionText} /><Text style={[styles.statusLabel, item.status === "blocked" && { color: colors.warning }]}>{item.status === "blocked" ? "Needs attention" : online && item.status === "sending" ? "Sending…" : "Saved on this phone"}</Text></View>
          <View style={styles.quotedReply}><Copy>{item.text}</Copy></View>
          {item.error && <Text style={styles.actionRowDetail}>{item.error}</Text>}
          <View style={styles.headerTitleRow}>
            <TextAction title="Open conversation" onPress={() => router.push({ pathname: "/ticket/[projectId]/[ticketId]", params: { projectId: item.projectId, ticketId: item.ticketId } })} />
            {item.status !== "sending" && <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}><TextAction title={edit.isPending && edit.variables?.id === item.id ? "Retrying…" : "Retry"} disabled={!online || edit.isPending} onPress={() => edit.mutate({ id: item.id })} /><IconButton name="trash" label="Remove saved reply" plain disabled={edit.isPending} onPress={() => setRemoving(item.id)} /></View>}
          </View>
        </View>
      }} />
    </View>
    <Sheet open={!!removing} onClose={() => { if (!edit.isPending) setRemoving(null) }}><Heading>Remove this saved reply?</Heading><Copy muted>This removes it from this phone’s queue. It cannot recall a message that already reached the server.</Copy><Notice error={edit.error} /><Action title={edit.isPending ? "Removing…" : "Remove reply"} disabled={edit.isPending} onPress={() => { if (removing) edit.mutate({ id: removing, remove: true }) }} /><TextAction title="Keep reply" disabled={edit.isPending} onPress={() => setRemoving(null)} /></Sheet>
  </View>
}
