"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"

/** Play a short explanatory sequence when it enters view; never loop or hide content. */
export function AnimatedDiagram({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)")
    const change = () => {
      if (motion.matches) setActive(false)
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setActive(!motion.matches)
          observer.disconnect()
        }
      },
      { threshold: 0.2 }
    )
    observer.observe(element)
    motion.addEventListener("change", change)
    return () => {
      observer.disconnect()
      motion.removeEventListener("change", change)
    }
  }, [])
  return (
    <div ref={ref} className={className} data-animate={active}>
      {children}
    </div>
  )
}
