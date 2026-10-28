const configuredURL = (process.env.EXPO_PUBLIC_API_URL ?? (__DEV__ ? "http://localhost:3000" : "")).replace(/\/$/, "")
// Avoid a cross-host redirect during native authentication and cookie-bearing
// requests. Self-hosted origins keep their configured value.
export const API_URL = configuredURL === "https://trydatool.com" ? "https://www.trydatool.com" : configuredURL
// Keep build 11's disk keys so the origin correction cannot strand offline replies.
export const STORAGE_SCOPE = API_URL === "https://www.trydatool.com" ? "https://trydatool.com" : API_URL
export function assertApiUrl() {
  const url = new URL(API_URL)
  if (url.protocol !== "https:" && !(__DEV__ && url.protocol === "http:")) throw new Error("Configure an HTTPS Datool server URL for this build.")
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("The server URL must be an origin, without a path or credentials.")
}
