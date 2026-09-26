import "server-only"
import { cmsEnabled } from "./config"

export async function getCMS() {
  if (!cmsEnabled())
    throw new Error(
      "The CMS is disabled. Set DATOOL_CMS_ENABLED=true to enable it."
    )
  if (
    !process.env.PAYLOAD_SECRET ||
    !(process.env.PAYLOAD_DATABASE_URL || process.env.DATABASE_URL)
  ) {
    throw new Error(
      "Configure PAYLOAD_SECRET and PAYLOAD_DATABASE_URL (or DATABASE_URL) before using the CMS."
    )
  }
  const [{ getPayload }, { default: config }] = await Promise.all([
    import("payload"),
    import("@payload-config"),
  ])
  return getPayload({ config })
}
