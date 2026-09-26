export type CalibrationJudgment = "pass" | "fail" | "skip" | "error"
export type CalibrationFixture = {
  id: string
  expectedJudgments: Record<string, string>
}

/** Execution success is not calibration success. Every independently named criterion must match. */
export function checkCalibration(
  fixtures: CalibrationFixture[],
  judgments: {
    fixtureId: string
    criterion: string
    judgment: CalibrationJudgment
  }[]
) {
  const mismatches: {
    fixtureId: string
    criterion: string
    expected: string
    actual: string
  }[] = []
  for (const fixture of fixtures) {
    for (const [criterion, expected] of Object.entries(
      fixture.expectedJudgments
    )) {
      const matches = judgments.filter(
        (result) =>
          result.fixtureId === fixture.id && result.criterion === criterion
      )
      const actual =
        matches.length > 1 ? "duplicate" : (matches[0]?.judgment ?? "missing")
      if (actual !== expected)
        mismatches.push({ fixtureId: fixture.id, criterion, expected, actual })
    }
  }
  for (const result of judgments) {
    if (
      !fixtures.some(
        (f) =>
          f.id === result.fixtureId &&
          Object.hasOwn(f.expectedJudgments, result.criterion)
      )
    )
      mismatches.push({
        fixtureId: result.fixtureId,
        criterion: result.criterion,
        expected: "not requested",
        actual: result.judgment,
      })
  }
  return { passed: fixtures.length > 0 && mismatches.length === 0, mismatches }
}
