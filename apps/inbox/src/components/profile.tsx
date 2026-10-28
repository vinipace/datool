import { Pressable, Text, View } from "react-native"
import { Icon, type IconName } from "./icons"
import { styles } from "./styles"
import colors from "../theme.generated.json"

export function ProfileAction({ icon, title, onPress }: { icon: IconName; title: string; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={title} onPress={onPress} style={({ pressed }) => [styles.profileAction, pressed && styles.pressed]}>
    <Icon name={icon} size={25} color={colors.primary} />
    <Text style={styles.profileActionTitle}>{title}</Text>
  </Pressable>
}

export function ProfileDetail({ icon, title, value, stacked = false }: { icon: IconName; title: string; value: string; stacked?: boolean }) {
  return <View style={styles.profileDetail}>
    <Icon name={icon} size={22} />
    <View style={[styles.profileDetailCopy, stacked && styles.profileDetailStacked]}>
      <Text style={styles.profileDetailTitle}>{title}</Text>
      <Text selectable style={[styles.profileDetailValue, stacked && styles.profileDetailFullValue]}>{value}</Text>
    </View>
  </View>
}
