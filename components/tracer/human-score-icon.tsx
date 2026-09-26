import {
  CircleDot,
  ListChecks,
  SlidersHorizontal,
  TextCursorInput,
} from "lucide-react"
import type { HumanScore } from "@/src/lib/tracer/human-scores"

export function humanScoreIcon(score: HumanScore) {
  if (score.type === "numeric") return SlidersHorizontal
  if (score.type === "text") return TextCursorInput
  return score.multiple ? ListChecks : CircleDot
}
