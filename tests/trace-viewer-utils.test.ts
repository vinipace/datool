import { describe, expect, test } from "bun:test"

import {
  cn,
  formatDuration,
} from "@/components/ui/datool/trace-viewer/lib/utils"

describe("trace viewer utils", () => {
  test("formats long durations in compact and expanded forms", () => {
    expect(formatDuration(1_250)).toBe("1.25s")
    expect(formatDuration(65_000, true)).toBe("1.08m")
    expect(formatDuration(3_661_000)).toBe("1h 1m 1s")
  })

  test("merges class names", () => {
    expect(cn("p-2", "text-sm", "p-4")).toBe("text-sm p-4")
  })
})
