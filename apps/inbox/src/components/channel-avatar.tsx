import { View } from "react-native"
import { Avatar } from "./avatar"
import { channelIdentity } from "../lib/channels"
import { ChannelLogo } from "./channel-logo"
import { styles } from "./styles"
import colors from "../theme.generated.json"

export function ChannelAvatar({ name, channel, identityKey, imageUrl, size = 54, backdrop = colors.background }: { name: string; channel: string; identityKey?: string; imageUrl?: string | null; size?: number; backdrop?: string }) {
  const identity = channelIdentity(channel)
  const badgeSize = size < 48 ? 22 : size >= 100 ? 32 : 26
  const borderWidth = 2
  return <View accessible accessibilityRole="image" accessibilityLabel={`${name}, ${identity.label} channel`} pointerEvents="none" style={{ width: size, height: size, flexShrink: 0 }}>
    <Avatar name={name} identityKey={identityKey} imageUrl={imageUrl} size={size} />
    <View style={[styles.channelBadge, { width: badgeSize, height: badgeSize, borderRadius: badgeSize / 2, borderWidth, borderColor: backdrop, backgroundColor: backdrop, right: -2, bottom: -1 }]}>
      <ChannelLogo channel={channel} size={badgeSize - borderWidth * 2} />
    </View>
  </View>
}
