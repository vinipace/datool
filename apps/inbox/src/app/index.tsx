import { FlatList, Pressable, Text, View } from "react-native"
import { router } from "expo-router"
import { Stack } from "expo-router/stack"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useProjects } from "../lib/projects"
import { Avatar, IconButton, Notice, State } from "../components/ui"
import { Icon } from "../components/icons"
import { styles } from "../components/styles"
import colors from "../theme.generated.json"
import { OfflineBanner } from "../components/offline-banner"
import { useOnline } from "../lib/offline"

export default function Workspaces() {
  const online = useOnline()
  const insets = useSafeAreaInsets()
  const projects = useProjects()
  return <View style={styles.screen}><Stack.Screen options={{ headerShown: false }} /><View collapsable={false} style={[styles.frame, { paddingTop: insets.top }]}>
    <View style={[styles.inboxHeader, { paddingTop: 22, paddingBottom: 26 }]}><View style={styles.headerTitleRow}><Text accessibilityRole="header" style={[styles.title, { flex: 1 }]}>Workspaces</Text><IconButton name="user" label="Your account" onPress={() => router.push("/settings")} /></View><Text style={styles.actionRowDetail}>Choose where you’d like to help today.</Text></View>
    <FlatList style={styles.screen} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 30, gap: 12 }} contentInsetAdjustmentBehavior="automatic"
      data={projects.data?.pages.flatMap(p => p.items) ?? []} keyExtractor={item => item.id}
      onEndReached={() => { if (online && projects.hasNextPage && !projects.isFetchingNextPage) void projects.fetchNextPage() }}
      ListHeaderComponent={<View><OfflineBanner /><Notice error={projects.error} /></View>}
      ListEmptyComponent={<State icon="workspaces" loading={projects.isPending && online} title={!online ? "No saved workspaces" : projects.error ? "Couldn’t load workspaces" : "No workspaces yet"} description="Your Datool workspaces will appear here when you’re connected." retry={online ? () => void projects.refetch() : undefined} />}
      renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={`Open ${item.name}`} style={({ pressed }) => [styles.grouped, styles.actionRow, { gap: 14, paddingVertical: 19 }, pressed && styles.pressed]} onPress={() => router.navigate({ pathname: "/inbox/[projectId]", params: { projectId: item.id, name: item.name } })}>
        <Avatar name={item.name} identityKey={item.id} kind="workspace" size={46} /><View style={styles.actionRowCopy}><Text style={[styles.actionRowTitle, { fontWeight: "600" }]}>{item.name}</Text><Text style={styles.actionRowDetail}>{item.organizationName}</Text></View><Icon name="chevron" size={17} color={colors.muted} />
      </Pressable>} />
  </View></View>
}
