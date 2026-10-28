import { NativeTabs } from "expo-router/native-tabs"
import { useOutbox } from "../lib/offline"
import { useSession } from "../lib/session"
import colors from "../theme.generated.json"

/** UIKit owns Liquid Glass, safe-area behavior and accessibility on iOS 26+.
 * Older iOS uses its native material; Android uses Material navigation. */
export default function WorkspaceTabs() {
  const pending = useOutbox(useSession().data?.user.id).data?.filter(reply => reply.status !== "submitted").length ?? 0
  return <NativeTabs tintColor={colors.primary} backgroundColor={colors.surface} blurEffect="systemChromeMaterialDark" disableTransparentOnScrollEdge
    minimizeBehavior="never" backBehavior="initialRoute" indicatorColor={colors.selection} badgeBackgroundColor={colors.primary} badgeTextColor={colors.onPrimary}>
    <NativeTabs.Trigger name="index" contentStyle={{ backgroundColor: colors.background }}>
      <NativeTabs.Trigger.Label>Chats</NativeTabs.Trigger.Label>
      <NativeTabs.Trigger.Icon sf={{ default: "bubble.left.and.bubble.right", selected: "bubble.left.and.bubble.right.fill" }} md="chat_bubble" />
    </NativeTabs.Trigger>
    <NativeTabs.Trigger name="outbox" contentStyle={{ backgroundColor: colors.background }}>
      <NativeTabs.Trigger.Label>Outbox</NativeTabs.Trigger.Label>
      <NativeTabs.Trigger.Icon sf={{ default: "tray.and.arrow.up", selected: "tray.and.arrow.up.fill" }} md="outbox" />
      {pending > 0 && <NativeTabs.Trigger.Badge>{pending > 99 ? "99+" : String(pending)}</NativeTabs.Trigger.Badge>}
    </NativeTabs.Trigger>
    <NativeTabs.Trigger name="settings" contentStyle={{ backgroundColor: colors.background }}>
      <NativeTabs.Trigger.Label>You</NativeTabs.Trigger.Label>
      <NativeTabs.Trigger.Icon sf={{ default: "person.crop.circle", selected: "person.crop.circle.fill" }} md="account_circle" />
    </NativeTabs.Trigger>
  </NativeTabs>
}
