import { useId } from "react"
import { View } from "react-native"
import Svg, { Circle, Defs, G, LinearGradient, Path, Stop } from "react-native-svg"
import { channelIdentity } from "../lib/channels"
import { Icon } from "./icons"
import paths from "./channel-logo-paths.json"
import colors from "../theme.generated.json"

/** Bundled brand artwork; no remote image request is needed, including offline.
 * Telegram: https://telegram.org/img/t_logo.svg
 * Other glyphs: Simple Icons 13.0.0 (CC0); see assets/brands/README.md.
 */
export function ChannelLogo({ channel, size }: { channel: string; size: number }) {
  const identity = channelIdentity(channel)
  const gradientId = `channel-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  const brand = identity.brand
  if (!brand) return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.control, alignItems: "center", justifyContent: "center" }}>
    <Icon name={identity.icon} size={size * 0.68} color={colors.foreground} />
  </View>

  if (brand === "telegram") return <Svg width={size} height={size} viewBox="0 0 128 128">
    <Defs><LinearGradient id={gradientId} x1="50%" x2="50%" y1="0%" y2="100%">
      <Stop offset="0" stopColor={colors.brandTelegramTop} /><Stop offset="1" stopColor={colors.brandTelegramBottom} />
    </LinearGradient></Defs>
    <Circle cx="64" cy="64" r="64" fill={`url(#${gradientId})`} />
    <Path d={paths.telegram} fill={colors.brandWhite} />
  </Svg>

  return <Svg width={size} height={size} viewBox="0 0 32 32">
    {brand === "instagram" ? <>
      <Defs><LinearGradient id={gradientId} x1="0%" y1="100%" x2="85%" y2="0%">
        <Stop offset="0" stopColor={colors.brandInstagramYellow} />
        <Stop offset="0.25" stopColor={colors.brandInstagramOrange} />
        <Stop offset="0.5" stopColor={colors.brandInstagramPink} />
        <Stop offset="0.75" stopColor={colors.brandInstagramPurple} />
        <Stop offset="1" stopColor={colors.brandInstagramBlue} />
      </LinearGradient></Defs>
      <Circle cx="16" cy="16" r="16" fill={`url(#${gradientId})`} />
      <G transform="translate(6 6) scale(0.833333)"><Path d={paths.instagram} fill={colors.brandWhite} /></G>
    </> : brand === "whatsapp" ? <>
      <Circle cx="16" cy="16" r="16" fill={colors.channelWhatsapp} />
      <G transform="translate(5 5) scale(0.916667)"><Path d={paths.whatsapp} fill={colors.brandWhite} /></G>
    </> : brand === "messenger" ? <>
      <Circle cx="16" cy="16" r="16" fill={colors.brandWhite} />
      <G transform="translate(4 4)"><Path d={paths.messenger} fill={colors.brandMessenger} /></G>
    </> : <>
      <Circle cx="16" cy="16" r="16" fill={colors.brandWhite} />
      <G transform="translate(6 6) scale(0.833333)">
        <Path d={paths.slack.red} fill={colors.brandSlackRed} />
        <Path d={paths.slack.blue} fill={colors.brandSlackBlue} />
        <Path d={paths.slack.green} fill={colors.brandSlackGreen} />
        <Path d={paths.slack.yellow} fill={colors.brandSlackYellow} />
      </G>
    </>}
  </Svg>
}
