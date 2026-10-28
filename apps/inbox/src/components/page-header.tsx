import { Text, View } from "react-native"
import { router } from "expo-router"
import { IconButton } from "./ui"
import { styles } from "./styles"

export function PageHeader({ title, back = false }: { title: string; back?: boolean }) {
  return <View style={[styles.inboxHeader, { paddingTop: 18, paddingBottom: 22 }]}>
    {back && <View style={{ alignSelf: "flex-start", marginLeft: -8 }}><IconButton name="back" label="Back" plain onPress={() => { if (router.canGoBack()) router.back(); else router.replace("/") }} /></View>}
    <Text accessibilityRole="header" style={styles.title}>{title}</Text>
  </View>
}
