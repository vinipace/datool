"use client"

import { Line } from "recharts"

export function DashboardGapLines({
  gaps,
  color,
}: {
  gaps: { key: string; source: string }[]
  color: (source: string) => string
}) {
  return gaps.map(({ key, source }) => (
    <Line
      key={key}
      dataKey={key}
      type="linear"
      stroke={color(source)}
      strokeWidth={2}
      strokeOpacity={0.5}
      strokeDasharray="4 4"
      strokeLinecap="round"
      dot={false}
      activeDot={false}
      tooltipType="none"
      legendType="none"
      connectNulls={false}
      isAnimationActive={false}
    />
  ))
}
