import { useId, type ReactNode } from "react"
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { Image } from "expo-image"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg"
import { Icon, type IconName } from "./icons"
import colors from "../theme.generated.json"
import { authStyles } from "./auth-styles"
import loginBackground from "../../assets/login-background.jpg"
import appIcon from "../../assets/icon.png"
import googleLogo from "../../assets/google-signin.png"

/** Shared welcome/form shell. The photograph ships in the app for offline startup. */
export function AuthScreen({ children, onBack, busy = false, form = false }: { children: ReactNode; onBack?: () => void; busy?: boolean; form?: boolean }) {
  const insets = useSafeAreaInsets()
  const gradient = useId()
  return <View style={authStyles.screen}>
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
      <Image source={loginBackground} contentFit="cover" contentPosition="top" priority="high" style={StyleSheet.absoluteFill} />
      <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
        <Defs><LinearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={colors.background} stopOpacity={0.28} />
          <Stop offset="0.3" stopColor={colors.background} stopOpacity={0.06} />
          <Stop offset="0.6" stopColor={colors.background} stopOpacity={0.35} />
          <Stop offset="1" stopColor={colors.background} stopOpacity={0.9} />
        </LinearGradient></Defs>
        <Rect width="100%" height="100%" fill={`url(#${gradient})`} />
      </Svg>
      {form && <View style={[StyleSheet.absoluteFill, authStyles.formShade]} />}
    </View>
    <KeyboardAvoidingView style={authStyles.screen} behavior={process.env.EXPO_OS === "ios" ? "padding" : "height"}>
      <ScrollView style={authStyles.scroll} contentContainerStyle={[authStyles.content, { paddingTop: insets.top + 18, paddingBottom: Math.max(24, insets.bottom + 12) }]} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentInsetAdjustmentBehavior="never" showsVerticalScrollIndicator={false}>
        <View style={authStyles.header}>
          {onBack ? <Pressable accessibilityRole="button" accessibilityLabel="Back to sign in" accessibilityState={{ disabled: busy }} disabled={busy} onPress={onBack} style={({ pressed }) => [authStyles.back, pressed && authStyles.pressed, busy && authStyles.disabled]}><Icon name="back" size={24} /></Pressable> : <View style={authStyles.brand}><Image source={appIcon} style={authStyles.mark} /><Text style={authStyles.wordmark}>datool</Text></View>}
          <Text style={authStyles.eyebrow}>INBOX</Text>
        </View>
        <View style={[authStyles.body, form && authStyles.formBody]}>{children}</View>
      </ScrollView>
    </KeyboardAvoidingView>
  </View>
}

export function AuthButton({ title, onPress, icon, google = false, loading = false, disabled = false }: { title: string; onPress: () => void; icon?: IconName; google?: boolean; loading?: boolean; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled: disabled || loading, busy: loading }} disabled={disabled || loading} onPress={onPress} style={({ pressed }) => [authStyles.button, (disabled || loading) && authStyles.disabled, pressed && authStyles.pressed]}>
    {loading ? <ActivityIndicator color={colors.authOnButton} /> : google ? <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={authStyles.googleLogoClip}><Image source={googleLogo} style={authStyles.googleLogo} /></View> : icon ? <Icon name={icon} size={22} color={colors.authOnButton} /> : null}
    <Text style={authStyles.buttonText}>{title}</Text>
  </Pressable>
}

export function AuthFeedback({ message, error = false, loading = false }: { message: string; error?: boolean; loading?: boolean }) {
  return <View accessibilityRole={error ? "alert" : undefined} accessibilityLiveRegion="polite" style={authStyles.feedback}>
    {loading ? <ActivityIndicator color={colors.foreground} /> : <Icon name={error ? "info" : "shield"} size={20} color={error ? colors.error : colors.muted} />}
    <Text selectable style={authStyles.feedbackText}>{message}</Text>
  </View>
}

