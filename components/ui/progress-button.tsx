"use client"

import type { ComponentProps, CSSProperties } from "react"
import { Button } from "./button"
import { cn } from "@/lib/utils"
import styles from "./progress-button.module.css"

export function ProgressButton({
  active,
  durationMs,
  restartKey,
  paused,
  onProgressComplete,
  children,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "asChild"> & {
  active: boolean
  durationMs: number
  restartKey: number
  paused: boolean
  onProgressComplete: () => void
}) {
  return (
    <Button {...props} className={cn(styles.button, className)}>
      {active && (
        <span
          key={restartKey}
          aria-hidden="true"
          className={styles.progress}
          data-paused={paused || props.disabled || props.loading}
          style={{ "--progress-duration": `${durationMs}ms` } as CSSProperties}
          onAnimationEnd={onProgressComplete}
        />
      )}
      {children}
    </Button>
  )
}
