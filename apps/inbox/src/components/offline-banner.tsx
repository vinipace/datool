import { router, useLocalSearchParams } from "expo-router"
import { Pressable, Text, View } from "react-native"
import { useSession } from "../lib/session"
import { useOnline, useOutbox } from "../lib/offline"
import { Notice } from "./ui"
import { Icon } from "./icons"
import { styles } from "./styles"
import colors from "../theme.generated.json"

export function OfflineBanner() {
  const { projectId } = useLocalSearchParams<{ projectId?: string }>()
  const online = useOnline()
  const replies = useOutbox(useSession().data?.user.id)
  const pending = replies.data?.filter(item => item.status !== "submitted").length ?? 0
  if (online && !pending && !replies.error) return null
  const title = `Outbox · ${pending} ${pending === 1 ? "reply" : "replies"}`
  return <View style={styles.offlineRow}>
    {!online ? <><Icon name="offline" size={16} color={colors.muted} /><Text style={styles.offlineText}>You’re offline. Replies you write are saved on this phone.</Text></>
      : pending > 0 && <><Icon name="clock" size={16} color={colors.muted} /><Text style={styles.offlineText}>Replies waiting to send.</Text></>}
    <Notice error={replies.error} />
    {pending > 0 && <Pressable accessibilityRole="button" accessibilityLabel={title} onPress={() => router.navigate(projectId ? { pathname: "/inbox/[projectId]/outbox", params: { projectId } } : "/outbox")} style={({ pressed }) => [styles.outboxLink, pressed && styles.pressed]}><Text style={styles.actionText}>{title}</Text><Icon name="chevron" size={12} color={colors.primary} /></Pressable>}
  </View>
}
