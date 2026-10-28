import Svg, { Path, Circle } from "react-native-svg"
import { View } from "react-native"
import colors from "../theme.generated.json"

const paths = {
  back: "m15 5-7 7 7 7", search: "m21 21-5-5", close: "m6 6 12 12M6 18 18 6",
  more: "M5 12h.01M12 12h.01M19 12h.01", plus: "M12 5v14M5 12h14",
  send: "M12 19V5m-6 6 6-6 6 6", check: "m5 12 4 4L19 6",
  chats: "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5A8.5 8.5 0 0 1 10.5 3h2a8.5 8.5 0 0 1 8.5 8.5Z",
  outbox: "M8 8H5l-3 9v4h20v-4l-3-9h-3M2 17h5l2 2h6l2-2h5M12 14V2m-4 4 4-4 4 4",
  workspaces: "M3 9h18v12H3ZM3 9l3-6h12l3 6M8 21v-7h8v7",
  user: "M4 21v-2a8 8 0 0 1 16 0v2",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4",
  filter: "M4 7h16M7 12h10M10 17h4", chevron: "m9 5 7 7-7 7",
  clock: "M12 7v5l3 2", offline: "m3 3 18 18M8 8a9 9 0 0 0-5 3m5 4a6 6 0 0 1 8 0M12 19h.01M8 4a14 14 0 0 1 14 6",
  flag: "M5 22V3c5-4 9 4 14 0v11c-5 4-9-4-14 0",
  down: "m6 9 6 6 6-6", arrow: "M5 12h14m-5-5 5 5-5 5",
  retry: "M3 10a9 9 0 1 1 2 8M3 3v7h7", trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
  shield: "m12 2 9 4v6c0 6-9 10-9 10S3 18 3 12V6ZM8 12l3 3 5-6",
  info: "M12 11v6M12 7h.01", logout: "M9 3H4v18h5M10 12h11m-5-5 5 5-5 5",
  edit: "m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14Z", key: "M14 10a6 6 0 1 0-4 4l3 3h3v3h4v-4Z",
  globe: "M3 12h18M12 3a19 19 0 0 1 0 18 19 19 0 0 1 0-18",
  mail: "M3 5h18v14H3ZM3 5l9 7 9-7",
  phone: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .3 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.4 1.8.6 2.8.7a2 2 0 0 1 1.8 2.1Z",
  code: "m8 6-6 6 6 6M16 6l6 6-6 6M14 3l-4 18",
  headset: "M3 13v-2a9 9 0 0 1 18 0v7a4 4 0 0 1-4 4h-3M3 12h4v7H3ZM17 12h4v7h-4Z",
} as const
export type IconName = keyof typeof paths
export function Icon({ name, size = 24, color = colors.foreground }: { name: IconName; size?: number; color?: string }) {
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}><Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={name === "more" ? 4 : 1.8} strokeLinecap="round" strokeLinejoin="round">
    <Path d={paths[name]} />
    {name === "search" && <Circle cx="10.5" cy="10.5" r="6.5" />}
    {name === "user" && <Circle cx="12" cy="7" r="4" />}
    {(name === "clock" || name === "info") && <Circle cx="12" cy="12" r="9" />}
    {name === "globe" && <Circle cx="12" cy="12" r="9" />}
  </Svg></View>
}
