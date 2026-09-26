const BASIS_POINTS_PER_WHOLE = 10_000

/** A zero denominator is unavailable, never a fabricated zero ratio. */
export function ratioToBasisPoints(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null
  return Math.round((numerator / denominator) * BASIS_POINTS_PER_WHOLE)
}

/**
 * Allocate rounded parts so their sum remains equal to the rounded whole.
 * The stable index tie-breaker makes dashboard slices deterministic.
 */
export function allocateBasisPointContributions(
  numerators: readonly number[],
  denominator: number,
): Array<number | null> {
  if (denominator === 0) return numerators.map(() => null)

  const total = ratioToBasisPoints(
    numerators.reduce((sum, value) => sum + value, 0),
    denominator,
  )!
  const raw = numerators.map((value) => (value / denominator) * BASIS_POINTS_PER_WHOLE)
  const result = raw.map(Math.floor)
  let remainder = total - result.reduce((sum, value) => sum + value, 0)
  const order = raw
    .map((value, index) => ({ fraction: value - Math.floor(value), index }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index)

  for (let index = 0; remainder > 0; index += 1, remainder -= 1) {
    result[order[index % order.length]!.index] += 1
  }
  return result
}

export { BASIS_POINTS_PER_WHOLE }
