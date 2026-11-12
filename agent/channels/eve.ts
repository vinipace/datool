import { eveChannel } from "eve/channels/eve"
import { httpBasic } from "eve/channels/auth"

// Datool invokes the dedicated authenticated channel. Keep framework diagnostics private too.
export default eveChannel({ auth: request => {
  const password = process.env.DATOOL_EVE_SECRET
  if (!password || password.length < 32) return null
  return httpBasic({ username: "datool", password })(request)
} })
