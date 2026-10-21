/** Runtime opt-in shared by the web process and Build worker. */
export function buildEnabled() {
  return process.env.DATOOL_BUILD_ENABLED === "true"
}
