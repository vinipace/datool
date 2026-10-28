import AsyncStorage from "@react-native-async-storage/async-storage"
import Constants from "expo-constants"
import * as Crypto from "expo-crypto"
import { fetch } from "expo/fetch"
import { onlineManager } from "@tanstack/react-query"
import { diagnosticError, type DiagnosticStage } from "../../../../src/lib/inbox/diagnostics"
import { DiagnosticQueue } from "./diagnostics-core"
import { API_URL, STORAGE_SCOPE, assertApiUrl } from "./server-url"

const queue = new DiagnosticQueue(AsyncStorage, `datool-inbox-diagnostics:${STORAGE_SCOPE}`)
let nextFlush = 0
const recent = new Map<string, number>()
const version = (value: unknown) => typeof value === "string" && /^\d{1,9}(?:\.\d{1,9}){0,3}$/.test(value) ? value : "unknown"

export function reportError(stage: DiagnosticStage, error: unknown): void {
  // Never await diagnostics from the failed operation, and never report our own failures.
  try {
    const details = diagnosticError(error)
    const key = `${stage}:${details.code}:${details.httpStatus}`
    if (Date.now() - (recent.get(key) ?? 0) < 60_000) return
    recent.set(key, Date.now())
    const platform = process.env.EXPO_OS === "ios" ? "ios" : process.env.EXPO_OS === "android" ? "android" : "web"
    void queue.add({
      id: Crypto.randomUUID(), occurredAt: new Date().toISOString(), stage, ...details,
      platform, appVersion: version(Constants.expoConfig?.version),
      buildVersion: version(platform === "ios" ? Constants.platform?.ios?.buildNumber : String(Constants.expoConfig?.android?.versionCode ?? "unknown")),
      online: onlineManager.isOnline(),
    }).then(() => flushDiagnostics()).catch(() => {})
  } catch { /* Diagnostics must never break sign-in or recovery. */ }
}

export async function flushDiagnostics() {
  if (Date.now() < nextFlush) return
  try {
    assertApiUrl()
    await queue.flush(async report => {
      try {
        nextFlush = Date.now() + 30_000
        const response = await fetch(`${API_URL}/api/inbox-mobile/diagnostics`, {
          method: "POST", credentials: "omit", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(report), signal: AbortSignal.timeout(5000),
        })
        if (response.status === 429) {
          const seconds = Number(response.headers.get("retry-after"))
          nextFlush = Date.now() + Math.min(86400, Math.max(30, Number.isFinite(seconds) ? seconds : 60)) * 1000
        }
        if ([400, 409, 413].includes(response.status)) return "discard"
        if (!response.ok) return "retry"
        const receipt = await response.json()
        return receipt?.data?.id === report.id && receipt?.data?.status === "saved" ? "saved" : "retry"
      } catch { return "retry" }
    })
  } catch { /* Keep bounded local reports for the next foreground/reconnect. */ }
}
