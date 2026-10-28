import { useState } from "react"
import { ActivityIndicator, FlatList, Pressable, Text, View, useWindowDimensions } from "react-native"
import { Avatar, Heading, IconButton, Notice, Sheet, State, TextAction } from "./ui"
import { Icon } from "./icons"
import { styles } from "./styles"
import { useProjects } from "../lib/projects"
import { useOnline } from "../lib/offline"
import type { Project } from "../lib/types"
import colors from "../theme.generated.json"

// Row padding, two gaps, avatar and checkmark. Explicit bounds also constrain
// React Native text when the list is hosted inside the native sheet.
const rowChromeWidth = 13 * 2 + 13 * 2 + 42 + 22

export function ProjectPicker({ open, projectId, onClose, onSelect }: {
  open: boolean; projectId: string; onClose: () => void; onSelect: (project: Project) => void;
}) {
  const online = useOnline()
  const { height, fontScale } = useWindowDimensions()
  const [listWidth, setListWidth] = useState<number>()
  const [contentHeight, setContentHeight] = useState<number>()
  const projects = useProjects(open)
  const items = projects.data?.pages.flatMap(page => page.items) ?? []
  const listHeight = Math.min(height * 0.55, Math.max(180, contentHeight ?? items.length * 78 * fontScale))
  return <Sheet open={open} onClose={onClose}>
    <View style={styles.headerTitleRow}><Heading>Projects</Heading><IconButton name="close" label="Close project selector" plain onPress={onClose} /></View>
    {!online && <Text style={styles.actionRowDetail}>Offline · Showing saved projects</Text>}
    <FlatList style={{ height: listHeight, width: "100%" }} onLayout={event => setListWidth(event.nativeEvent.layout.width)} onContentSizeChange={(_, measuredHeight) => setContentHeight(measuredHeight)} data={items} keyExtractor={item => item.id} keyboardShouldPersistTaps="handled"
      onEndReached={() => { if (open && online && projects.hasNextPage && !projects.isFetching && !projects.isFetchNextPageError) void projects.fetchNextPage() }}
      ListEmptyComponent={<State icon="workspaces" loading={projects.isPending && online} title={!online ? "No saved projects" : projects.error ? "Couldn’t load projects" : "No projects yet"} description={!online ? "Reconnect to find your projects." : projects.error ? "Check your connection and try again." : "Projects you have access to will appear here."} retry={online && projects.error ? () => void projects.refetch() : undefined} />}
      ListFooterComponent={items.length > 0 ? <View>
        <Notice error={projects.error} />
        {projects.isFetchingNextPage ? <ActivityIndicator color={colors.muted} accessibilityLabel="Loading projects" /> : online && (projects.hasNextPage || projects.error) ? <TextAction title={projects.error ? "Retry loading projects" : "Load more projects"} onPress={() => { if (projects.hasNextPage) void projects.fetchNextPage(); else void projects.refetch() }} /> : null}
      </View> : undefined}
      renderItem={({ item }) => {
        const selected = item.id === projectId
        return <Pressable accessibilityRole="button" accessibilityLabel={`Switch to ${item.name}`} accessibilityHint={item.organizationName} accessibilityState={{ selected }} aria-selected={selected} onPress={() => onSelect(item)} style={({ pressed }) => [styles.projectOption, { width: listWidth }, selected && styles.projectOptionSelected, pressed && styles.pressed]}>
          <Avatar name={item.name} identityKey={item.id} kind="workspace" size={42} />
          <View style={[styles.actionRowCopy, listWidth !== undefined && { maxWidth: Math.max(0, listWidth - rowChromeWidth) }]}><Text style={styles.projectOptionName}>{item.name}</Text><Text style={styles.actionRowDetail}>{item.organizationName}</Text></View>
          <View style={{ width: 22 }}>{selected && <Icon name="check" size={22} color={colors.primary} />}</View>
        </Pressable>
      }} />
  </Sheet>
}
