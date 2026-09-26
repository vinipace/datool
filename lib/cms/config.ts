/** Read at request time so one production image supports either installation. */
export function cmsEnabled() {
  return process.env.DATOOL_CMS_ENABLED === "true"
}
