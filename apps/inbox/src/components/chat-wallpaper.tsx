import { StyleSheet, View } from "react-native"
import Svg, { Defs, G, Path, Pattern, Rect, Circle } from "react-native-svg"
import colors from "../theme.generated.json"

/** Original repeating line art; bundled SVG works without a network request. */
export function ChatWallpaper() {
  return <View pointerEvents="none" style={StyleSheet.absoluteFill} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <Svg width="100%" height="100%" opacity={0.75}><Defs><Pattern id="chat-doodles" width="240" height="260" patternUnits="userSpaceOnUse" patternTransform="scale(0.8)">
      <G stroke={colors.wallpaper} strokeWidth="1.25" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <G transform="translate(20 20) rotate(-16)"><Path d="M0 4Q0 0 5 0h29q5 0 5 5v21q0 5-5 5H13l-9 8v-8Q0 31 0 26Z" /><Path d="M9 10h22M9 18h15" /></G>
        <G transform="translate(116 16) rotate(18)"><Path d="m0 12 43-12-14 42-9-18Z M20 24 43 0M20 24l-2 13 11-8" /></G>
        <G transform="translate(177 52) rotate(-12)"><Rect width="39" height="29" rx="5" /><Path d="m0 2 19 14L39 2" /></G>
        <G transform="translate(20 107) rotate(12)"><Path d="M2 17C-9 5 6-5 15 6c10-11 25-1 14 11L15 31Z" /></G>
        <G transform="translate(88 87) rotate(-12)"><Path d="m18 0 5 12 14 2-11 9 3 14-11-7L6 37l3-14L0 14l13-2Z" /></G>
        <G transform="translate(169 134) rotate(14)"><Path d="M0 25V13a20 20 0 0 1 40 0v12M0 16h7v18H0Zm33 0h7v18h-7ZM33 34q0 8-15 7" /></G>
        <G transform="translate(55 189) rotate(-14)"><Rect width="33" height="45" rx="6" /><Path d="M10 6h13M12 38h9" /><Circle cx="16" cy="23" r="7" /></G>
        <G transform="translate(129 216) rotate(12)"><Path d="M0 0h30v22q0 7-8 7H8q-8 0-8-7ZM30 5h7q10 8 0 16h-7M6-11q-5-5 0-10M20-11q-5-5 0-10" /></G>
        <Path d="m81 50 3 5 6 1-4 4 1 6-6-3-5 3 1-6-4-4 6-1Zm60 101 6-5 6 5-6 5Zm64 80 5 8m-9-2 13-4M9 224l5 5-5 5m209-128 5 5-5 5M110 173q8-10 16 0t16 0" />
        <Circle cx="72" cy="135" r="3" /><Circle cx="195" cy="15" r="3" /><Circle cx="16" cy="175" r="3" /><Circle cx="224" cy="197" r="3" />
      </G>
    </Pattern></Defs><Rect width="100%" height="100%" fill="url(#chat-doodles)" /></Svg>
  </View>
}
