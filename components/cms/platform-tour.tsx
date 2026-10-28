"use client"

import { useEffect, useRef, useState } from "react"
import { useReducedMotion } from "motion/react"
import { productIcons } from "@/components/product-icons"
import { ProgressButton } from "@/components/ui/progress-button"
import { PlatformPreview, type PreviewPage } from "./platform-preview"
import styles from "./home.module.css"

const stops: {
  page: PreviewPage
  label: string
  caption: string
  icon: (typeof productIcons)[keyof typeof productIcons]
}[] = [
  {
    page: "build",
    label: "Build",
    icon: productIcons.buildAgents,
    caption: "Launch agents and work every conversation from one inbox.",
  },
  {
    page: "observe",
    label: "Observe",
    icon: productIcons.traces,
    caption: "Follow every request, model call and tool call.",
  },
  {
    page: "improve",
    label: "Improve",
    icon: productIcons.evals,
    caption: "Compare versions on real conversations before you ship.",
  },
]
const stopDurationMs = 7000

/** Build, Observe and Improve buttons that walk the real workspace screen. */
export function PlatformTour() {
  const reduced = useReducedMotion() ?? false
  const [active, setActive] = useState(0)
  const [cycle, setCycle] = useState(0)
  // Autoplay stops for good once a visitor picks a page themselves.
  const [touched, setTouched] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [visible, setVisible] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const playing = !reduced && !touched && !hovered && visible

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry.isIntersecting)
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const choose = (page: PreviewPage) => {
    setTouched(true)
    setActive(stops.findIndex((stop) => stop.page === page))
  }

  return (
    <div
      ref={ref}
      className={styles.tour}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setHovered(false)
      }}
    >
      <div
        className={styles.tourTabs}
        role="group"
        aria-label="Explore the workspace"
        data-autoplay={!touched}
      >
        {stops.map((stop, index) => (
          <ProgressButton
            key={stop.page}
            active={!touched && active === index}
            durationMs={stopDurationMs}
            restartKey={cycle}
            paused={!playing}
            onProgressComplete={() => {
              setActive((active + 1) % stops.length)
              setCycle(cycle + 1)
            }}
            variant="ghost"
            className={styles.tourTab}
            aria-pressed={active === index}
            aria-controls="platform-preview"
            onClick={() => choose(stop.page)}
          >
            <span className={styles.tourLabel}>
              <stop.icon aria-hidden="true" />
              {stop.label}
            </span>
            <span className={styles.tourCaption}>{stop.caption}</span>
          </ProgressButton>
        ))}
      </div>
      {/* The screen starts on the page and runs into the forest band below. */}
      <section className={styles.showcase}>
        <span className={styles.showcaseBand} aria-hidden="true" />
        {/* The product screen keeps the app's dark theme. */}
        <div className={`dark ${styles.screen}`}>
          <PlatformPreview
            areas
            page={stops[active].page}
            onPageChange={choose}
          />
        </div>
        <p className={styles.showcaseCaption}>
          The real Datool workspace with example data.
        </p>
      </section>
    </div>
  )
}
