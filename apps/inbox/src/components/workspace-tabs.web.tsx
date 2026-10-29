import { Pressable, StyleSheet, Text, View } from "react-native"
import type { ComponentRef, Ref } from "react"
import { Tabs, TabList, TabSlot, TabTrigger, type TabTriggerSlotProps } from "expo-router/ui"
import { BlurView } from "expo-blur"
import { Icon, type IconName } from "./icons"
import { styles } from "./styles"
import { useOutbox } from "../lib/offline"
import { useSession } from "../lib/session"
import { useWorkspace } from "../lib/workspace"
import colors from "../theme.generated.json"

function TabButton({ isFocused, label, icon, badge = 0, ...props }: Omit<TabTriggerSlotProps, "ref"> & { ref?: Ref<ComponentRef<typeof View>>; label: string; icon: IconName; badge?: number }) {
  return <Pressable {...props} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected: isFocused }} aria-selected={isFocused} style={({ pressed }) => [styles.dockItem, isFocused && styles.dockActive, pressed && styles.pressed]}>
    <View><Icon name={icon} size={25} color={isFocused ? colors.foreground : colors.muted} />{badge > 0 && <View style={styles.badge}><Text style={styles.badgeText}>{badge > 99 ? "99+" : badge}</Text></View>}</View>
    <Text style={[styles.dockLabel, !isFocused && { color: colors.muted }]}>{label}</Text>
  </Pressable>
}

/** Browser preview only. The native app renders the operating system tab bar. */
export default function WorkspaceTabs() {
  const { projectId } = useWorkspace()
  const pending = useOutbox(useSession().data?.user.id).data?.filter(reply => reply.status !== "submitted").length ?? 0
  return <Tabs style={styles.screen} options={{ backBehavior: "initialRoute" }}>
    <TabSlot style={styles.screen} />
    <TabList asChild>
      <BlurView tint="systemChromeMaterialDark" intensity={85} style={StyleSheet.flatten([styles.dockGlass, styles.dock, { position: "absolute", bottom: 14, width: "90%", alignSelf: "center" }])}>
          <TabTrigger name="chats" href={{ pathname: "/inbox/[projectId]", params: { projectId } }} asChild><TabButton label="Chats" icon="chats" /></TabTrigger>
          <TabTrigger name="outbox" href={{ pathname: "/inbox/[projectId]/outbox", params: { projectId } }} asChild><TabButton label="Outbox" icon="outbox" badge={pending} /></TabTrigger>
          <TabTrigger name="you" href={{ pathname: "/inbox/[projectId]/settings", params: { projectId } }} asChild><TabButton label="You" icon="user" /></TabTrigger>
      </BlurView>
    </TabList>
  </Tabs>
}
