import { publicOrigin } from "@/lib/public-origin"
import { cmsEnabled } from "@/lib/cms/config"

/** Self-hosted installations never send data to Datool Cloud's property. */
export function siteMeasurementId() {
  if (!cmsEnabled()) return null
  const configured = process.env.DATOOL_GA_MEASUREMENT_ID
  if (configured === "disabled") return null
  const id =
    configured ||
    (publicOrigin() === "https://www.trydatool.com" ? "G-D44MGF0E6K" : null)
  return id && /^G-[A-Z0-9]+$/.test(id) ? id : null
}
