import * as Notifications from "expo-notifications"
import * as SecureStore from "expo-secure-store"
import * as Crypto from "expo-crypto"
import * as Device from "expo-device"
import Constants from "expo-constants"
import { api } from "./api"

if (process.env.EXPO_OS !== "web") Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }) })
export async function installationId() {
  if (process.env.EXPO_OS === "web") {
    const id = localStorage.getItem("datool-inbox-installation") ?? Crypto.randomUUID()
    localStorage.setItem("datool-inbox-installation", id)
    return id
  }
  const saved = await SecureStore.getItemAsync("datool-inbox-installation")
  if (saved) return saved
  const id = Crypto.randomUUID()
  await SecureStore.setItemAsync("datool-inbox-installation", id)
  return id
}
export async function subscribe(projectId: string) {
  if (!Device.isDevice || process.env.EXPO_OS === "web") throw new Error("Enable push notifications on a physical phone using a Datool development or release build.")
  const easProjectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId
  if (!easProjectId) throw new Error("This build is not linked to an EAS project yet.")
  if (process.env.EXPO_OS === "android") await Notifications.setNotificationChannelAsync("inbox", { name: "Inbox handoffs", importance: Notifications.AndroidImportance.HIGH, sound: "default", lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE })
  let permission = await Notifications.getPermissionsAsync()
  if (!permission.granted) permission = await Notifications.requestPermissionsAsync()
  if (!permission.granted) throw new Error("Allow notifications for Datool Inbox in your phone’s Settings.")
  const token = (await Notifications.getExpoPushTokenAsync({ projectId: easProjectId })).data
  await api("/api/inbox-mobile/devices", { method: "POST", body: JSON.stringify({ installationId: await installationId(), token }) }, projectId)
}
export async function unsubscribe(projectId?: string) {
  await api("/api/inbox-mobile/devices", { method: "DELETE", body: JSON.stringify({ installationId: await installationId(), projectId }) })
}
/** Refresh an existing opt-in on app activation and APNs/FCM token changes.
 * This never prompts or subscribes a workspace the user did not select. */
export async function refreshSubscriptions() {
  if (process.env.EXPO_OS === "web" || !Device.isDevice) return
  const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId
  if (!projectId || !(await Notifications.getPermissionsAsync()).granted) return
  const devices = await api<{ projectId: string }[]>(`/api/inbox-mobile/devices?installationId=${await installationId()}`)
  if (!devices.length) return
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data
  for (const device of devices) await api("/api/inbox-mobile/devices", { method: "POST", body: JSON.stringify({ installationId: await installationId(), token }) }, device.projectId)
}
export function ticketDestination(data: Record<string, unknown> | undefined) {
  const valid = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value)
  return valid(data?.projectId) && valid(data?.ticketId) ? { projectId: data.projectId, ticketId: data.ticketId } : null
}
