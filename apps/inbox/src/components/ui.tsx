import type { ComponentRef, ReactNode, Ref } from "react"
import { ActivityIndicator, Pressable, Text, TextInput, View, type TextInputProps } from "react-native"
import { BottomSheet, Button, Host, RNHostView } from "@expo/ui"
import { Icon, type IconName } from "./icons"
import colors from "../theme.generated.json"
import { styles } from "./styles"
export { Avatar } from "./avatar"

export function Action({ title, onPress, disabled = false, secondary = false }: { title: string; onPress: () => void; disabled?: boolean; secondary?: boolean }) {
  return <Host matchContents colorScheme="dark" seedColor={colors.primary} style={{ minHeight: 44 }}><Button label={title} onPress={onPress} disabled={disabled} variant={secondary ? "outlined" : "filled"} /></Host>
}
export function Copy({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return <Text selectable style={{ color: muted ? colors.muted : colors.foreground, fontSize: 15, lineHeight: 22 }}>{children}</Text>
}
export function Heading({ children }: { children: ReactNode }) {
  return <Text selectable style={styles.heading}>{children}</Text>
}
export function Notice({ error }: { error: unknown }) {
  if (!error) return null
  return <Text selectable accessibilityRole="alert" style={{ color: colors.error, paddingVertical: 8 }}>{error instanceof Error ? error.message : String(error)}</Text>
}
export function State({ loading, error, title, description, retry, icon = "chats" }: { loading?: boolean; error?: unknown; title: string; description?: string; retry?: () => void; icon?: IconName }) {
  return <View style={styles.state}>{loading ? <ActivityIndicator color={colors.muted} accessibilityLabel="Loading" /> : <><View style={styles.stateIcon}><Icon name={error ? "offline" : icon} size={28} color={colors.muted} /></View><Text style={[styles.heading, { textAlign: "center" }]}>{title}</Text></>}
    <Notice error={error} />{description && <Text style={styles.stateDescription}>{description}</Text>}{retry && !loading && <TextAction title="Try again" onPress={retry} />}</View>
}
export function Field(props: TextInputProps & { ref?: Ref<ComponentRef<typeof TextInput>> }) {
  return <TextInput placeholderTextColor={colors.muted} selectionColor={colors.primary} {...props} style={[styles.field, props.style]} />
}
export function Chip({ title, label, selected, onPress, trailingIcon }: { title: string; label?: string; selected: boolean; onPress: () => void; trailingIcon?: IconName }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label ?? title} accessibilityState={{ selected }} aria-selected={selected} onPress={onPress} hitSlop={{ top: 5, bottom: 5 }} style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.pressed]}>
    <Text numberOfLines={1} style={[styles.chipText, selected && { color: colors.selectionText }]}>{title}</Text>
    {trailingIcon && <Icon name={trailingIcon} size={14} color={selected ? colors.selectionText : colors.muted} />}
  </Pressable>
}

export function IconButton({ name, label, onPress, disabled, accent = false, plain = false, tint, indicator = false }: { name: IconName; label: string; onPress: () => void; disabled?: boolean; accent?: boolean; plain?: boolean; tint?: string; indicator?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.iconButton, accent && { backgroundColor: colors.primary }, plain && { backgroundColor: "transparent" }, disabled && styles.disabled, pressed && styles.pressed]}>
    <Icon name={name} size={22} color={tint ?? (accent ? colors.onPrimary : colors.foreground)} />
    {indicator && <View style={styles.filterDot} />}
  </Pressable>
}
export function TextAction({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={title} disabled={disabled} accessibilityState={{ disabled: !!disabled }} onPress={onPress} style={({ pressed }) => [styles.textAction, disabled && styles.disabled, pressed && styles.pressed]}><Text style={styles.actionText}>{title}</Text></Pressable>
}
/** Compact filled capsule for the one primary action in a status strip; keeps a 44pt hit area. */
export function PillAction({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={title} disabled={disabled} accessibilityState={{ disabled: !!disabled }} onPress={onPress} style={({ pressed }) => [styles.pillAction, disabled && styles.disabled, pressed && styles.pressed]}>
    <View style={styles.pillActionFace}><Text numberOfLines={1} style={styles.pillActionText}>{title}</Text></View>
  </Pressable>
}
export function Sheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  return <Host colorScheme="dark" seedColor={colors.primary}><BottomSheet isPresented={open} onDismiss={onClose} containerColor={colors.surface} contentPadding={0}><RNHostView matchContents={{ vertical: true }}><View style={styles.sheet}>{children}</View></RNHostView></BottomSheet></Host>
}

export function ActionRow({ icon, title, detail, onPress, disabled, destructive, trailing }: { icon: IconName; title: string; detail?: string; onPress?: () => void; disabled?: boolean; destructive?: boolean; trailing?: ReactNode }) {
  return <Pressable accessibilityRole={onPress ? "button" : undefined} accessibilityLabel={title} accessibilityState={onPress ? { disabled: !!disabled } : undefined} disabled={disabled || !onPress} onPress={onPress} style={({ pressed }) => [styles.actionRow, disabled && styles.disabled, pressed && styles.pressed]}>
    <Icon name={icon} size={22} color={destructive ? colors.error : colors.foreground} />
    <View style={styles.actionRowCopy}><Text style={[styles.actionRowTitle, destructive && { color: colors.error }]}>{title}</Text>{detail && <Text style={styles.actionRowDetail}>{detail}</Text>}</View>
    {trailing ?? (onPress && <Icon name="chevron" size={15} color={colors.muted} />)}
  </Pressable>
}

export function InboxSkeleton() {
  return <View accessible accessibilityLabel="Loading" accessibilityRole="progressbar">{Array.from({ length: 5 }, (_, i) => <View key={i} style={styles.chatRow}>
    <View style={[styles.avatar, { width: 54, height: 54, borderRadius: 27, backgroundColor: colors.surface }]} />
    <View style={[styles.chatRowBody, { gap: 12, minHeight: 78 }]}><View style={[styles.skeleton, { width: i % 2 ? "42%" : "55%" }]} /><View style={[styles.skeleton, { width: i % 2 ? "76%" : "88%", opacity: 0.5 }]} /></View>
  </View>)}</View>
}
