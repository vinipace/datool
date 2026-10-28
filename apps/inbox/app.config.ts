import type { ExpoConfig } from "expo/config"
import colors from "./src/theme.generated.json"

const config: ExpoConfig = {
  name: "Datool Inbox",
  slug: "datool-inbox",
  owner: "vinpac",
  version: "1.0.0",
  scheme: "datool-inbox",
  userInterfaceStyle: "dark",
  backgroundColor: colors.background,
  icon: "./assets/icon.png",
  ios: { bundleIdentifier: "com.datool.inbox", supportsTablet: true, infoPlist: { ITSAppUsesNonExemptEncryption: false } },
  android: {
    package: "com.datool.inbox", allowBackup: false,
    ...(process.env.GOOGLE_SERVICES_JSON ? { googleServicesFile: process.env.GOOGLE_SERVICES_JSON } : {}),
  },
  plugins: ["expo-router", "expo-secure-store", "expo-web-browser", "expo-image", ["expo-notifications", {
    defaultChannel: "inbox",
    mode: process.env.EAS_BUILD_PROFILE === "production" ? "production" : "development",
  }]],
  experiments: { typedRoutes: true },
  extra: { eas: { projectId: "5204541c-1d7d-42a9-bb64-73a6483fdf77" } },
}
export default config
