import { readFile } from "node:fs/promises"
import { checkCalibration } from "../src/lib/tracer/calibration"
import fixtures from "../examples/scorer-calibration/brand-extraction.json"
const path = process.argv[2]
if (!path)
  throw new Error(
    "Usage: bun scripts/check-scorer-calibration.ts judgments.json"
  )
const result = checkCalibration(
  fixtures.fixtures,
  JSON.parse(await readFile(path, "utf8"))
)
console.info(JSON.stringify(result, null, 2))
process.exitCode = result.passed ? 0 : 2
