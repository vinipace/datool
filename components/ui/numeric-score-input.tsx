"use client"

import { Input } from "./input"
import { Slider } from "./slider"

export function NumericScoreInput({
  label,
  value,
  onValueChange,
  disabled,
  min = 0,
  max = 1,
  step = 0.01,
}: {
  min?: number
  max?: number
  step?: number
  label: string
  value: string
  onValueChange: (value: string) => void
  disabled?: boolean
}) {
  const number = Number(value)
  const invalid =
    value !== "" && (!Number.isFinite(number) || number < min || number > max)
  return (
    <div className="flex items-center gap-3">
      <Slider
        aria-label={`${label} value slider`}
        min={min}
        max={max}
        step={step}
        value={[
          Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : min,
        ]}
        onValueChange={([next]) => onValueChange(String(next))}
        onPointerDown={() => {
          // Selecting the minimum must register even when the thumb already rests there.
          if (!disabled && value === "") onValueChange(String(min))
        }}
        onKeyDown={(event) => {
          if (!disabled && value === "" && event.key === "Home")
            onValueChange(String(min))
        }}
        disabled={disabled}
        className="min-w-0 flex-1 [&_[data-slot=slider-track]]:bg-background"
      />
      <Input
        aria-label={`${label} value`}
        type="number"
        min={min}
        max={max}
        step="any"
        required
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        disabled={disabled}
        invalid={invalid}
        className="w-20 shrink-0 tabular-nums"
      />
    </div>
  )
}
