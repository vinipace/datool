import { useEffect, useRef, useState } from "react"
import { FlatList, Pressable, Text, TextInput, View } from "react-native"
import { router, useLocalSearchParams } from "expo-router"
import { Stack } from "expo-router/stack"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { KeyboardAvoidingView, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller"
import Animated, { useAnimatedStyle } from "react-native-reanimated"
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query"
import * as Crypto from "expo-crypto"
import { build } from "../../../lib/api"
import { queryClient } from "../../../lib/query"
import { useSession } from "../../../lib/session"
import { messageText, type Message, type Ownership, type Page, type Ticket } from "../../../lib/types"
import { ActionRow, Copy, Heading, IconButton, Notice, PillAction, Sheet, State, TextAction } from "../../../components/ui"
import { ChannelAvatar } from "../../../components/channel-avatar"
import { channelLabel } from "../../../lib/channels"
import { Icon } from "../../../components/icons"
import { MessageBubble } from "../../../components/message-bubble"
import { styles } from "../../../components/styles"
import colors from "../../../theme.generated.json"
import { outbox, syncOutbox, useOnline, useOutbox } from "../../../lib/offline"
import { OfflineBanner } from "../../../components/offline-banner"

type Draft = { text: string; key: string }
const newDraft = (): Draft => ({ text: "", key: Crypto.randomUUID() })
export default function Conversation() {
  const { projectId, ticketId, showActions } = useLocalSearchParams<{ projectId: string; ticketId: string; showActions?: string }>()
  const session = useSession()
  const online = useOnline()
  const savedReplies = useOutbox(session.data?.user.id)
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  const [actionsRequested, setActionsRequested] = useState(false)
  const actionsOpen = actionsRequested || showActions === "1"
  function setActionsOpen(open: boolean) {
    setActionsRequested(open)
    if (!open && showActions === "1") router.setParams({ showActions: "0" })
  }
  const [webComposerHeight, setWebComposerHeight] = useState(44)
  const messageList = useRef<FlatList<Message>>(null)
  const awayFromLatest = useRef(false)
  const [showLatest, setShowLatest] = useState(false)
  const insets = useSafeAreaInsets()
  const { progress } = useReanimatedKeyboardAnimation()
  const composerInset = useAnimatedStyle(() => ({ paddingBottom: 6 + Math.max(0, insets.bottom - 6) * (1 - progress.value) }))
  const draftKey = ["draft", session.data?.user.id, projectId, ticketId]
  const { data: draft } = useQuery({ queryKey: draftKey, queryFn: newDraft, enabled: false, initialData: newDraft })
  const draftWasQueued = savedReplies.data?.some(reply => reply.id === draft.key && reply.projectId === projectId && reply.ticketId === ticketId) ?? false
  useEffect(() => {
    // The cache snapshot can lag behind the durable outbox on an abrupt restart.
    // Reconcile by ID so an already queued reply never becomes an unsent draft.
    if (draftWasQueued) queryClient.setQueryData(["draft", session.data?.user.id, projectId, ticketId], newDraft())
  }, [draftWasQueued, session.data?.user.id, projectId, ticketId])
  const ticket = useQuery({ queryKey: ["ticket", projectId, ticketId], queryFn: ({ signal }) => build<Ticket>(projectId, "build_get_ticket", { id: ticketId }, { signal }), refetchInterval: 5000 })
  const conversationId = ticket.data?.conversationId
  const ownership = useQuery({ queryKey: ["ownership", projectId, conversationId], enabled: !!conversationId, queryFn: ({ signal }) => build<Ownership>(projectId, "build_get_conversation_ownership", { conversationId }, { signal }), refetchInterval: 5000 })
  // Keep the first-page marker stable across JSON cache restoration, while
  // leaving the optional API cursor absent for that first page.
  const messages = useInfiniteQuery({ queryKey: ["messages", projectId, conversationId], enabled: !!conversationId, initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => build<Page<Message>>(projectId, "build_list_conversation_messages", { conversationId, limit: 50, before: pageParam ?? undefined }, { signal }),
    getNextPageParam: page => page.nextCursor ?? undefined, refetchInterval: 5000 })
  async function refresh() {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ["ticket", projectId, ticketId] }), queryClient.invalidateQueries({ queryKey: ["ownership", projectId, conversationId] }), queryClient.invalidateQueries({ queryKey: ["messages", projectId, conversationId] }), queryClient.invalidateQueries({ queryKey: ["inbox", projectId] })])
  }
  const action = useMutation({ mutationFn: async (kind: "join" | "return" | "solve" | "reopen") => {
    if (!ticket.data || !ownership.data) throw new Error("Wait for the conversation to load.")
    if (kind === "join") return build(projectId, "build_takeover_conversation", { conversationId, expectedVersion: ownership.data.version || undefined })
    if (kind === "return") return build(projectId, "build_resume_conversation", { conversationId, expectedVersion: ownership.data.version, leaseToken: ownership.data.leaseToken ?? undefined })
    return build(projectId, "build_update_ticket", { id: ticketId, status: kind === "solve" ? "solved" : "open", expectedVersion: ticket.data.version })
  }, onSettled: refresh })
  const send = useMutation({ networkMode: "always", mutationFn: async (attempt: Draft) => {
    if (!session.data?.user.id || !conversationId) throw new Error("Open a conversation before saving a reply.")
    await outbox.enqueue({ id: attempt.key, userId: session.data.user.id, projectId, ticketId, conversationId, text: attempt.text.trim() })
  }, onSuccess: () => {
    queryClient.setQueryData(draftKey, newDraft())
    messageList.current?.scrollToOffset({ offset: 0, animated: false })
    if (online && session.data?.user.id) void syncOutbox(session.data.user.id).catch(() => queryClient.invalidateQueries({ queryKey: ["outbox"] }))
  } })
  function back() { if (router.canGoBack()) router.back(); else router.replace({ pathname: "/inbox/[projectId]", params: { projectId } }) }
  if (!ticket.data) return <View style={[styles.screen, { paddingTop: insets.top }]}><Stack.Screen options={{ headerShown: false }} /><View style={styles.toolbar}><IconButton name="back" label="Back to chats" onPress={back} /></View><State loading={ticket.isPending && online} title={online ? "Conversation unavailable" : "This conversation is not saved yet"} description={online ? undefined : "Reconnect to load it on this phone."} error={ticket.error} retry={online ? () => void ticket.refetch() : undefined} /></View>
  const owner = ownership.data
  const mine = owner?.mode === "human" && owner.ownerUserId === session.data?.user.id
  const leaseActive = mine && (!owner.leaseExpiresAt || Date.parse(owner.leaseExpiresAt) > now)
  const solved = ["solved", "closed"].includes(ticket.data.status)
  const busy = action.isPending || send.isPending
  const items = [...new Map(messages.data?.pages.flatMap(p => p.items).filter(m => m.role === "user" || m.role === "assistant").map(m => [m.id, m])).values()].sort((a, b) => b.ordinal - a.ordinal)
  const pending = savedReplies.data?.filter(reply => reply.projectId === projectId && reply.ticketId === ticketId && !items.some(message => message.id === reply.serverMessageId || message.metadata.clientMessageId === reply.id)) ?? []
  const pendingCount = pending.filter(reply => reply.status !== "submitted").length
  const name = ticket.data.contactName || "Customer"
  const joinTitle = leaseActive ? "Return to agent" : mine ? "Renew session" : "Join conversation"
  const joinDisabled = !online || busy || !owner || !!ownership.error || (leaseActive && pendingCount > 0)
  const clock = (value: string | number) => new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  const day = (value: string) => new Date(value).toDateString() === new Date(now).toDateString() ? "Today" : new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
  const sameRun = (a: Message, b?: Message) => !!b && b.role === a.role && b.metadata.actorId === a.metadata.actorId && day(b.createdAt) === day(a.createdAt)
  // Keep keyboard avoidance at the screen root so no header offset is counted twice.
  return <KeyboardAvoidingView behavior="padding" style={[styles.screen, { paddingTop: insets.top, backgroundColor: colors.header }]}>
    <Stack.Screen options={{ title: name, headerShown: false }} />
    <View style={styles.frame}>
      <View style={styles.chatHeader}>
        <IconButton name="back" label="Back to chats" onPress={back} />
        <Pressable accessibilityRole="button" accessibilityLabel={`Details for ${name}`} accessibilityHint="Opens contact info" onPress={() => router.push({ pathname: "/contact/[projectId]/[ticketId]", params: { projectId, ticketId } })} style={({ pressed }) => [styles.chatHeaderIdentityButton, pressed && styles.pressed]}>
          <ChannelAvatar name={name} channel={ticket.data.channel} identityKey={ticket.data.contactId || ticket.data.conversationId} size={40} backdrop={colors.header} />
          <View style={styles.chatHeaderIdentity}><Text numberOfLines={1} style={styles.chatHeaderName}>{name}</Text><Text numberOfLines={1} style={styles.chatHeaderSubtitle}>{channelLabel(ticket.data.channel)} · {ticket.data.assigneeName || ticket.data.teamName || "Unassigned"}</Text></View>
        </Pressable>
        <IconButton name="more" label="Conversation actions" onPress={() => setActionsOpen(true)} />
      </View>
      <View style={styles.ownershipBar}>
        <Icon name={solved ? "check" : leaseActive ? "user" : !online ? "offline" : "chats"} size={16} color={leaseActive ? colors.primary : colors.muted} />
        <Text style={[styles.ownershipText, leaseActive && !solved && { color: colors.foreground }]}>{solved ? "Conversation solved" : !online ? "Saved conversation · Offline" : leaseActive ? "You’re replying" : mine ? "Your reply session expired" : owner?.mode === "ai" ? "AI agent is handling this" : owner?.ownerUserId && !owner.ownerUserId.startsWith("team:") ? "Another teammate is replying" : "Ready for your team"}</Text>
        {leaseActive && !solved ? <TextAction title="Details" onPress={() => setActionsOpen(true)} /> : !solved ? <PillAction title={action.isPending ? "Joining…" : joinTitle} disabled={joinDisabled} onPress={() => action.mutate("join")} /> : <PillAction title="Reopen ticket" disabled={!online || busy || !owner || pendingCount > 0} onPress={() => action.mutate("reopen")} />}
      </View>
      <View style={styles.timeline}>
        <View style={styles.timeline}>
          <FlatList ref={messageList} inverted style={{ flex: 1 }} maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 80 }} scrollEventThrottle={100}
            onScroll={event => { const away = event.nativeEvent.contentOffset.y > 240; if (away !== awayFromLatest.current) { awayFromLatest.current = away; setShowLatest(away) } }} contentContainerStyle={styles.transcript} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive"
            data={items} keyExtractor={item => item.id}
            onEndReached={() => { if (online && messages.hasNextPage && !messages.isFetchingNextPage) void messages.fetchNextPage() }}
            ListHeaderComponent={<View><Notice error={messages.error} />{pending.map((reply, index) => <MessageBubble key={reply.id} grouped={index > 0} tail={index === pending.length - 1} outgoing text={reply.text} time={clock(reply.createdAt)} status={!online && reply.status === "sending" ? "queued" : reply.status} error={reply.error} />)}</View>}
            ListEmptyComponent={<State loading={messages.isPending && online} title={!online ? "No saved messages" : messages.error ? "Could not load messages" : "No messages yet"} retry={online ? () => void messages.refetch() : undefined} />}
            ListFooterComponent={messages.hasNextPage ? <TextAction title={messages.isFetchingNextPage ? "Loading…" : "Load earlier messages"} disabled={!online || messages.isFetchingNextPage} onPress={() => void messages.fetchNextPage()} /> : undefined}
            renderItem={({ item, index }) => <View>
              {(!items[index + 1] || day(item.createdAt) !== day(items[index + 1]!.createdAt)) && <View style={styles.datePill}><Text style={styles.dateText}>{day(item.createdAt)}</Text></View>}
              <MessageBubble text={messageText(item.content) || "[Message content available in the web inbox]"} outgoing={item.role === "assistant"} grouped={sameRun(item, items[index + 1])} tail={!sameRun(item, items[index - 1])}
                author={item.role === "assistant" && item.metadata.source !== "human" ? `${item.author?.name || "Agent"} · AI` : item.metadata.source === "human" && item.metadata.actorId !== session.data?.user.id ? item.author?.name || "Teammate" : undefined}
                time={clock(item.createdAt)} status={item.metadata.source === "human" ? "submitted" : undefined} />
            </View>} />
          {showLatest && <View style={styles.jumpToLatest}><IconButton name="down" label="Jump to latest message" onPress={() => messageList.current?.scrollToOffset({ offset: 0, animated: false })} /></View>}
        </View>
        <OfflineBanner />
        <Animated.View style={[styles.composer, composerInset]}>
          <Notice error={send.error ?? action.error ?? ownership.error ?? ticket.error} />
          {ownership.error && <TextAction title="Refresh ownership" onPress={() => void ownership.refetch()} />}
          {solved && <View style={styles.composerNote}><Icon name="check" size={16} color={colors.muted} /><Text style={[styles.quietCaption, { flexShrink: 1, textAlign: "center" }]}>This conversation is solved. Reopen it to reply.</Text></View>}
          {!solved && <View style={styles.composerRow}>
            <TextInput accessibilityLabel="Reply to customer" placeholder={online && !leaseActive ? "Join to send a reply" : "Message"} placeholderTextColor={colors.muted} selectionColor={colors.primary} multiline maxLength={16000} value={draftWasQueued || savedReplies.isPending ? "" : draft.text} editable={!send.isPending && !savedReplies.isPending} style={[styles.composerField, process.env.EXPO_OS === "web" && { height: webComposerHeight }]} onContentSizeChange={process.env.EXPO_OS === "web" ? event => setWebComposerHeight(Math.max(44, Math.min(140, event.nativeEvent.contentSize.height))) : undefined} onChangeText={text => queryClient.setQueryData(draftKey, { text, key: Crypto.randomUUID() })} />
            <IconButton name={send.isPending ? "clock" : "send"} label={send.isPending ? "Saving…" : !online ? "Queue reply" : send.error ? "Retry saving reply" : "Send reply"} accent disabled={busy || savedReplies.isPending || draftWasQueued || (online && (!leaseActive || !!ownership.error)) || !draft.text.trim()} onPress={() => send.mutate(draft)} />
          </View>}
        </Animated.View>
      </View>
    </View>
    <Sheet open={actionsOpen} onClose={() => setActionsOpen(false)}>
      <View style={styles.profile}><ChannelAvatar name={name} channel={ticket.data.channel} identityKey={ticket.data.contactId || ticket.data.conversationId} backdrop={colors.surface} /><View style={{ flex: 1, gap: 4 }}><Heading>{name}</Heading><Copy muted>{ticket.data.subject || "Customer conversation"}</Copy></View></View>
      <View style={styles.statusPill}><Icon name={solved ? "check" : "chats"} size={14} color={colors.selectionText} /><Text style={styles.statusLabel}>{ticket.data.status.charAt(0).toUpperCase() + ticket.data.status.slice(1)} · {channelLabel(ticket.data.channel)}</Text></View>
      <Copy muted>{ticket.data.assigneeName || ticket.data.teamName || "Unassigned"}</Copy>
      <Notice error={action.error} />
      <View style={styles.grouped}>
        {!solved && <><ActionRow icon={leaseActive ? "arrow" : "user"} title={joinTitle} detail={leaseActive ? "Let the AI agent continue this conversation" : "Take over and reply to the customer"} disabled={joinDisabled} onPress={() => action.mutate(leaseActive ? "return" : "join", { onSuccess: () => setActionsOpen(false) })} /><View style={styles.divider} /></>}
        <ActionRow icon="check" title={solved ? "Reopen ticket" : "Mark solved"} detail={solved ? "Move this conversation back to Open" : "Move this conversation to Solved"} disabled={!online || busy || !owner || !!ownership.error || pendingCount > 0} onPress={() => action.mutate(solved ? "reopen" : "solve", { onSuccess: () => setActionsOpen(false) })} />
      </View>
      {pendingCount > 0 && <Text style={styles.quietCaption}>Send or remove your saved replies before returning or solving this conversation.</Text>}
      <TextAction title="Done" onPress={() => setActionsOpen(false)} />
    </Sheet>
  </KeyboardAvoidingView>
}
