import { useEffect, useRef, useState, type ComponentRef } from "react"
import { ActivityIndicator, FlatList, Pressable, ScrollView, Text, TextInput, View } from "react-native"
import { router, useNavigation } from "expo-router"
import { StackActions } from "expo-router/react-navigation"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { build } from "../lib/api"
import type { Agent, Page, Ticket, Project } from "../lib/types"
import { Chip, Heading, IconButton, InboxSkeleton, Notice, Sheet, State, TextAction } from "../components/ui"
import { ChannelAvatar } from "../components/channel-avatar"
import { channelLabel } from "../lib/channels"
import { Icon } from "../components/icons"
import { useProjects } from "../lib/projects"
import { useWorkspace } from "../lib/workspace"
import { ProjectPicker } from "../components/project-picker"
import { chatDate } from "../lib/format"
import { styles } from "../components/styles"
import colors from "../theme.generated.json"
import { OfflineBanner } from "../components/offline-banner"
import { useOnline } from "../lib/offline"

const queues = ["Open", "Mine", "Unassigned", "Solved"] as const
export default function Inbox() {
  const online = useOnline()
  const insets = useSafeAreaInsets()
  const list = useRef<FlatList<Ticket>>(null)
  const { projectId, name } = useWorkspace()
  const workspaceNavigation = useNavigation("/")
  const [queue, setQueue] = useState<typeof queues[number]>("Open")
  const [agentId, setAgentId] = useState("")
  const [agentPicker, setAgentPicker] = useState(false)
  const [projectPicker, setProjectPicker] = useState(false)
  const [search, setSearch] = useState("")
  const [submittedSearch, setSubmittedSearch] = useState("")
  const searchInput = useRef<ComponentRef<typeof TextInput>>(null)
  const [searchFocused, setSearchFocused] = useState(false)
  useEffect(() => { const timer = setTimeout(() => setSubmittedSearch(search.trim()), 250); return () => clearTimeout(timer) }, [search])
  const projects = useProjects()
  const workspaceName = projects.data?.pages.flatMap(page => page.items).find(project => project.id === projectId)?.name || name || "Projects"
  function clearSearch() { setSearch(""); setSubmittedSearch(""); searchInput.current?.blur(); setSearchFocused(false) }
  function selectProject(project: Project) {
    setProjectPicker(false)
    if (project.id === projectId) return
    clearSearch(); setAgentId(""); setQueue("Open")
    list.current?.scrollToOffset({ offset: 0, animated: false })
    // Replace the project route in the root stack, not just the active tab.
    workspaceNavigation.dispatch(StackActions.replace("inbox/[projectId]", { projectId: project.id, name: project.name }))
  }
  const agents = useQuery({ queryKey: ["agents", projectId], queryFn: ({ signal }) => build<Agent[]>(projectId, "build_list_agents", {}, { signal }) })
  // JSON persists undefined array entries as null. Use a durable sentinel and
  // omit it from the API payload, including caches saved by previous builds.
  const tickets = useInfiniteQuery({ queryKey: ["inbox", projectId, agentId, queue, submittedSearch], initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => build<Page<Ticket>>(projectId, "build_list_tickets", {
      order: "recent", limit: 30, cursor: pageParam ?? undefined, search: submittedSearch || undefined, agentId: agentId || undefined,
      status: queue === "Solved" ? "solved" : queue === "Open" ? "open" : undefined,
      queue: queue === "Mine" ? "mine" : queue === "Unassigned" ? "unassigned" : undefined,
    }, { signal }), getNextPageParam: page => page.nextCursor ?? undefined, refetchInterval: 10_000 })
  const [refreshing, setRefreshing] = useState(false)
  async function refreshInbox() { if (!online) return; setRefreshing(true); try { await tickets.refetch() } finally { setRefreshing(false) } }
  const items = [...new Map(tickets.data?.pages.flatMap(page => page.items).map(item => [item.id, item])).values()]
  const agentName = agents.data?.find(agent => agent.id === agentId)?.name || "Selected agent"
  return <View style={styles.screen}>
    <View collapsable={false} style={[styles.frame, { paddingTop: insets.top }]}>
      <View style={styles.projectHeader}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Choose project: ${workspaceName}`} accessibilityHint="Opens the project selector" accessibilityState={{ expanded: projectPicker }} onPress={() => { searchInput.current?.blur(); setSearchFocused(false); setProjectPicker(true) }} style={({ pressed }) => [styles.projectTitleButton, pressed && styles.pressed]}>
          <Text accessibilityRole="header" numberOfLines={1} ellipsizeMode="tail" style={[styles.title, styles.projectTitle]}>{workspaceName}</Text><Icon name="down" size={19} color={colors.muted} />
        </Pressable>
      </View>
      <FlatList ref={list} style={styles.screen} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: process.env.EXPO_OS === "web" ? 110 : 24 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
        data={items} keyExtractor={item => item.id} refreshing={refreshing} onRefresh={() => void refreshInbox()}
        onEndReached={() => { if (online && tickets.hasNextPage && !tickets.isFetchingNextPage) void tickets.fetchNextPage() }}
        ListHeaderComponent={<><View style={styles.inboxHeader}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}><View style={styles.search}>
            <IconButton name="search" label="Search" plain tint={colors.muted} onPress={() => setSubmittedSearch(search.trim())} />
            <TextInput ref={searchInput} onFocus={() => setSearchFocused(true)} accessibilityLabel="Search conversations" placeholder="Search name or subject" placeholderTextColor={colors.muted} selectionColor={colors.primary} style={styles.searchField} autoCorrect={false} autoCapitalize="none" value={search} onChangeText={value => { setSearch(value); if (!value) setSubmittedSearch("") }} onSubmitEditing={() => setSubmittedSearch(search.trim())} returnKeyType="search" />
            {!!search && <IconButton name="close" label="Clear search" plain tint={colors.muted} onPress={() => { setSearch(""); setSubmittedSearch("") }} />}
          </View>{searchFocused ? <TextAction title="Cancel" onPress={clearSearch} /> : <IconButton name="filter" label="Filter by agent" indicator={!!agentId} onPress={() => setAgentPicker(true)} />}</View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={[styles.filterRow, { paddingHorizontal: 16 }]}>
            {!!agentId && <Chip title={agentName} label={`${agentName} · Clear filter`} trailingIcon="close" selected onPress={() => setAgentId("")} />}
            {queues.map(q => <Chip key={q} title={q} selected={queue === q} onPress={() => setQueue(q)} />)}
          </ScrollView>
          {!!items.length && tickets.error && <View style={styles.infoCard}><Icon name="offline" size={18} color={colors.muted} /><Text style={styles.infoCardText}>Couldn’t refresh. Showing your saved conversations.</Text><TextAction title="Retry" onPress={() => void tickets.refetch()} /></View>}
        </View><OfflineBanner /></>}
        ListEmptyComponent={tickets.isPending && online ? <InboxSkeleton /> : <State icon={tickets.error || (!online && !tickets.data) ? "offline" : submittedSearch ? "search" : queue === "Solved" ? "check" : "chats"} title={!online && !tickets.data ? "This view isn’t saved yet" : tickets.error ? "Couldn’t load conversations" : submittedSearch ? "No conversations found" : queue === "Solved" ? "No solved conversations" : "You’re all caught up"} description={!online && !tickets.data ? "Reconnect to load it. Your saved chats and replies are still available." : tickets.error ? "Check your connection and try again." : submittedSearch ? `No results for “${submittedSearch}”. Try another name or subject.` : queue === "Solved" ? "Conversations you resolve will appear here." : "When an agent hands a conversation to your team, you’ll find it here."} retry={online && tickets.error ? () => void tickets.refetch() : undefined} />}

        ListFooterComponent={tickets.isFetchingNextPage ? <View style={[styles.content, { alignItems: "center" }]}><ActivityIndicator color={colors.muted} accessibilityLabel="Loading more conversations" /></View> : undefined}
        renderItem={({ item }) => {
          const urgent = item.priority === "urgent", flagged = urgent || item.priority === "high"
          const solved = item.status === "solved" || item.status === "closed"
          const hint = [`${channelLabel(item.channel)} channel`, flagged && `${item.priority} priority`, solved && "Solved"].filter(Boolean).join(", ")
          return <Pressable accessibilityRole="button" accessibilityLabel={`Open conversation with ${item.contactName || item.subject || "customer"}`} accessibilityHint={hint} style={({ pressed }) => [styles.chatRow, pressed && { backgroundColor: colors.surface }]}
            onPress={() => router.push({ pathname: "/ticket/[projectId]/[ticketId]", params: { projectId, ticketId: item.id } })}>
            <ChannelAvatar name={item.contactName || item.subject || "Customer"} channel={item.channel} identityKey={item.contactId || item.conversationId} />
            <View style={styles.chatRowBody}>
              <View style={styles.chatRowTop}><Text numberOfLines={1} style={styles.chatName}>{item.contactName || item.subject || "Customer conversation"}</Text><Text style={styles.timestamp}>{chatDate(item.updatedAt)}</Text></View>
              <View style={styles.chatRowPreview}>
                <Text numberOfLines={2} style={styles.preview}>{item.subject || `${channelLabel(item.channel)} conversation`}</Text>
                {(flagged || solved) && <View style={styles.rowMarkers}>{solved && <Icon name="check" size={16} color={colors.muted} />}{flagged && <Icon name="flag" size={16} color={urgent ? colors.error : colors.warning} />}</View>}
              </View>
            </View>
          </Pressable>
        }} />
    </View>
    <ProjectPicker open={projectPicker} projectId={projectId} onClose={() => setProjectPicker(false)} onSelect={selectProject} />
    <Sheet open={agentPicker} onClose={() => setAgentPicker(false)}><Heading>Filter by agent</Heading><ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ gap: 8 }}><Chip title="All agents" selected={!agentId} onPress={() => { setAgentId(""); setAgentPicker(false) }} />{agents.data?.map(agent => <Chip key={agent.id} title={agent.name} selected={agentId === agent.id} onPress={() => { setAgentId(agent.id); setAgentPicker(false) }} />)}<Notice error={agents.error} /></ScrollView><TextAction title="Done" onPress={() => setAgentPicker(false)} /></Sheet>
  </View>
}
