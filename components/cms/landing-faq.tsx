"use client"

import { useId, useState, type ReactNode } from "react"
import { motion, useReducedMotion } from "motion/react"
import { Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import styles from "./landing-faq.module.css"

const ease = [0.22, 1, 0.36, 1] as const

export type LandingFAQItem = {
  id?: string | null
  question: string
  answer: ReactNode
  /** The question's own page; modified clicks on the question open it. */
  href?: string
}

/** Landing page FAQ: a large title beside questions that open one at a time. */
export function LandingFAQ({
  title,
  items,
  className,
}: {
  title: string
  items: LandingFAQItem[]
  className?: string
}) {
  const id = useId()
  const reduced = useReducedMotion() ?? false
  const [open, setOpen] = useState<number | null>(0)
  return (
    <section
      className={cn(styles.faq, className)}
      aria-labelledby={`${id}-title`}
    >
      <h2 id={`${id}-title`} className={styles.title}>
        {title}
      </h2>
      <div className={styles.list}>
        {items.map((item, index) => {
          const expanded = open === index
          return (
            <div
              key={item.id || index}
              className={styles.item}
              data-open={expanded}
            >
              <h3>
                {item.href ? (
                  <a
                    id={`${id}-q${index}`}
                    href={item.href}
                    role="button"
                    className={styles.question}
                    aria-expanded={expanded}
                    aria-controls={`${id}-a${index}`}
                    onClick={(event) => {
                      // Cmd, Ctrl, Shift and middle clicks still open the page.
                      if (
                        event.button !== 0 ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return
                      event.preventDefault()
                      setOpen(expanded ? null : index)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === " ") {
                        event.preventDefault()
                        setOpen(expanded ? null : index)
                      }
                    }}
                  >
                    {item.question}
                    <Plus aria-hidden="true" />
                  </a>
                ) : (
                  <button
                    type="button"
                    id={`${id}-q${index}`}
                    className={styles.question}
                    aria-expanded={expanded}
                    aria-controls={`${id}-a${index}`}
                    onClick={() => setOpen(expanded ? null : index)}
                  >
                    {item.question}
                    <Plus aria-hidden="true" />
                  </button>
                )}
              </h3>
              {/* Closed answers stay in the HTML so every answer and link is indexable. */}
              <motion.div
                id={`${id}-a${index}`}
                role="region"
                aria-labelledby={`${id}-q${index}`}
                className={styles.answer}
                inert={!expanded}
                initial={false}
                animate={
                  expanded
                    ? { height: "auto", opacity: 1 }
                    : { height: 0, opacity: 0 }
                }
                transition={
                  reduced ? { duration: 0 } : { duration: 0.35, ease }
                }
              >
                <div>
                  {typeof item.answer === "string" ? (
                    <p>{item.answer}</p>
                  ) : (
                    item.answer
                  )}
                </div>
              </motion.div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
