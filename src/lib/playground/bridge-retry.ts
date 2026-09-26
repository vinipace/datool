/** Protocol 2 permits at most two minutes of consecutive transport disruption.
 * Its lease and delivery window include request timeout and scheduling margin. */
export const BRIDGE_RETRY_BUDGET_MS = 120_000
export const BRIDGE_DELIVERY_GRACE_MS = 150_000
