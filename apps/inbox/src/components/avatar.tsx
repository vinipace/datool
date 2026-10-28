import { useState } from "react"
import { StyleSheet, Text, View } from "react-native"
import { Image } from "expo-image"
import Svg, { Path, Rect } from "react-native-svg"
import { Icon } from "./icons"
import colors from "../theme.generated.json"

const palettes = [
  [colors.avatarCobalt, colors.avatarCobaltShade, colors.avatarLight],
  [colors.avatarAmber, colors.avatarAmberShade, colors.avatarInk],
  [colors.avatarCoral, colors.avatarCoralShade, colors.avatarInk],
  [colors.avatarTeal, colors.avatarTealShade, colors.avatarLight],
  [colors.avatarViolet, colors.avatarVioletShade, colors.avatarLight],
  [colors.avatarRose, colors.avatarRoseShade, colors.avatarInk],
  [colors.avatarSky, colors.avatarSkyShade, colors.avatarInk],
  [colors.avatarRust, colors.avatarRustShade, colors.avatarLight],
  [colors.avatarLime, colors.avatarLimeShade, colors.avatarInk],
  [colors.avatarIndigo, colors.avatarIndigoShade, colors.avatarLight],
  [colors.avatarEmerald, colors.avatarEmeraldShade, colors.avatarLight],
  [colors.avatarStone, colors.avatarStoneShade, colors.avatarInk],
] as const

function identityHash(value: string) {
  let hash = 2166136261
  for (const character of value) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619)
  // Mix the high bits too, so similar IDs distribute across both color and artwork.
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b)
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35)
  hash ^= hash >>> 16
  return hash >>> 0
}

// Large, simple silhouettes stay recognizable at the 40pt conversation-header size.
const motifs = [
  "M0 0 H100 V24 L0 88Z", // diagonal
  "M100 0 V100 H60 A50 65 0 0 1 60 0Z", // side crescent
  "M0 0 H50 V50 H100 V100 H50 V50 H0Z", // opposing quarters
  "M0 100 V80 H28 V56 H72 V32 H100 V100Z", // steps
  "M0 100 V78 Q50 20 100 78 V100Z", // arch
  "M0 0 H100 V24 H24 V100 H0Z", // corner
] as const

/** Local, stable artwork: no generated faces or remote avatar service. */
export function Avatar({ name, identityKey, size = 54, imageUrl, kind = "person" }: {
  name: string; identityKey?: string; size?: number; imageUrl?: string | null; kind?: "person" | "workspace";
}) {
  const [loadedImage, setLoadedImage] = useState<string | null>(null)
  const normalizedName = name.trim().normalize("NFC")
  const hash = identityHash(identityKey || normalizedName.toLowerCase())
  const [base, shade, ink] = palettes[hash % palettes.length]!
  const motif = motifs[(hash >>> 12) % motifs.length]!
  const words = normalizedName.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}'’-]*/gu) ?? []
  const initials = [words[0], words.length > 1 ? words.at(-1) : undefined].filter(Boolean).map(word => [...word!][0]).join("").toUpperCase()
  const imageKey = `${identityKey ?? normalizedName}:${imageUrl ?? ""}`
  const radius = kind === "workspace" ? size * 0.3 : size / 2
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none" style={[avatarStyles.face, { width: size, height: size, borderRadius: radius, backgroundColor: base }]}>
    <Svg width={size} height={size} viewBox="0 0 100 100" style={StyleSheet.absoluteFill}>
      <Rect width="100" height="100" fill={base} />
      <Path d={motif} fill={shade} />
    </Svg>
    {initials ? <Text numberOfLines={1} adjustsFontSizeToFit maxFontSizeMultiplier={1} style={[avatarStyles.initials, { color: ink, fontSize: size * (initials.length === 1 ? 0.44 : 0.36), lineHeight: size * 0.56, letterSpacing: -size * 0.01 }]}>{initials}</Text> : <Icon name={kind === "workspace" ? "workspaces" : "user"} size={size * 0.46} color={ink} />}
    {!!imageUrl && <Image key={imageKey} source={imageUrl} recyclingKey={imageKey} contentFit="cover" cachePolicy="memory-disk" onLoad={() => setLoadedImage(imageKey)} onError={() => setLoadedImage(null)} style={[StyleSheet.absoluteFill, { opacity: loadedImage === imageKey ? 1 : 0 }]} />}
    <View style={[StyleSheet.absoluteFill, avatarStyles.edge, { borderRadius: radius }]} />
  </View>
}

const avatarStyles = StyleSheet.create({
  face: { alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0 },
  initials: { fontWeight: "700", textAlign: "center", includeFontPadding: false },
  edge: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.avatarEdge },
})
