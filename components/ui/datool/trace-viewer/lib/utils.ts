import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const durationFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
})

const MS_IN_SECOND = 1000
const MS_IN_MINUTE = 60 * MS_IN_SECOND
const MS_IN_HOUR = 60 * MS_IN_MINUTE
const MS_IN_DAY = 24 * MS_IN_HOUR

export function formatDuration(ms: number, compact = false): string {
  if (ms === 0) {
    return "0"
  }

  if (ms < MS_IN_SECOND) {
    return `${durationFormatter.format(ms)}ms`
  }

  if (ms < MS_IN_MINUTE) {
    return `${durationFormatter.format(ms / MS_IN_SECOND)}s`
  }

  if (compact) {
    if (ms < MS_IN_HOUR) {
      return `${durationFormatter.format(ms / MS_IN_MINUTE)}m`
    }

    return `${durationFormatter.format(ms / MS_IN_HOUR)}h`
  }

  const days = Math.floor(ms / MS_IN_DAY)
  const hours = Math.floor((ms % MS_IN_DAY) / MS_IN_HOUR)
  const minutes = Math.floor((ms % MS_IN_HOUR) / MS_IN_MINUTE)
  const seconds = Math.floor((ms % MS_IN_MINUTE) / MS_IN_SECOND)
  const parts: string[] = []

  if (days > 0) {
    parts.push(`${days}d`)
  }

  if (hours > 0) {
    parts.push(`${hours}h`)
  }

  if (minutes > 0) {
    parts.push(`${minutes}m`)
  }

  if (hours <= 1 && (seconds > 0 || parts.length === 0)) {
    parts.push(`${seconds}s`)
  }

  return parts.join(" ")
}
