"use client"

import { useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import {
  AnimatePresence,
  motion,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
} from "motion/react"
import { ArrowDown, MessageCircle } from "lucide-react"
import type { AgentLanding } from "@/payload-types"
import { Button } from "@/components/ui/button"
import {
  formatWhatsappNumber,
  whatsappHref,
  type AgentLandingView,
} from "@/cms/agent-landing-content"
import { getFAQPath } from "@/lib/cms/faq"
import { StoryDevice } from "./agent-landing-chat"
import { AgentLandingFeatures } from "./agent-landing-features"
import { LandingFAQ, type LandingFAQItem } from "./landing-faq"
import { CMSRichText } from "./page-blocks"
import { accentFont } from "./accent-font"
import styles from "./agent-landing.module.css"

const ease = [0.22, 1, 0.36, 1] as const
const wideQuery = "(min-width: 960px)"
function subscribeWide(onChange: () => void) {
  const query = window.matchMedia(wideQuery)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

function WhatsAppAction({
  whatsapp,
  label,
  size = "xl",
  className,
}: {
  whatsapp: AgentLanding["whatsapp"]
  label: string
  size?: "xl" | "2xl"
  className?: string
}) {
  return (
    <Button asChild variant="whatsapp" size={size} className={className}>
      <a
        href={whatsappHref(whatsapp)}
        target="_blank"
        rel="noopener noreferrer"
      >
        <MessageCircle aria-hidden="true" />
        {label}
        <span className="sr-only"> (opens WhatsApp)</span>
      </a>
    </Button>
  )
}

// The hero opens the story so the phone is already on screen beside it.
function Story({
  story,
  channel,
  intro,
}: {
  story: AgentLanding["story"]
  channel: AgentLanding["channel"]
  intro: ReactNode
}) {
  const list = useRef<HTMLOListElement>(null)
  const chapters = story.chapters ?? []
  const [active, setActive] = useState(0)
  // The reading line sits mid-screen; on narrow screens the chapters scroll
  // invisibly behind a full-height stage that captions the active one.
  const wide = useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(wideQuery).matches,
    () => true
  )
  const { scrollYProgress } = useScroll({
    target: list,
    offset: wide ? ["start 65%", "end 65%"] : ["start 60%", "end 60%"],
  })
  const marks = useRef<(HTMLElement | null)[]>([])
  // The chapter whose heading has crossed the reading line drives the phone.
  useMotionValueEvent(scrollYProgress, "change", () => {
    const line = window.innerHeight * (wide ? 0.65 : 0.6)
    setActive(
      marks.current.reduce(
        (current, mark, index) =>
          mark && mark.getBoundingClientRect().top <= line ? index : current,
        0
      )
    )
  })
  return (
    <div className={styles.story}>
      {intro}
      <div className={styles.stage}>
        <StoryDevice story={story} channel={channel} active={active} />
        {!wide && chapters[active] && (
          <div className={styles.caption} aria-hidden="true">
            <p className={styles.captionMeta}>
              <span>
                {String(active + 1).padStart(2, "0")} /{" "}
                {String(chapters.length).padStart(2, "0")}
              </span>
              {chapters[active].time}
            </p>
            <span className={styles.captionTrack}>
              <motion.span
                className={styles.captionProgress}
                style={{ scaleX: scrollYProgress }}
              />
            </span>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={active}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.3, ease }}
              >
                <p className={styles.captionTitle}>{chapters[active].title}</p>
                <p className={styles.captionText}>{chapters[active].text}</p>
              </motion.div>
            </AnimatePresence>
          </div>
        )}
      </div>
      <ol id="story" ref={list} className={styles.chapters}>
        <motion.span
          aria-hidden="true"
          className={styles.rail}
          style={{ scaleY: scrollYProgress }}
        />
        {chapters.map((chapter, index) => (
          <li
            key={chapter.id || index}
            className={styles.chapter}
            data-active={index === active}
            aria-current={index === active ? "step" : undefined}
          >
            <p
              ref={(element) => {
                marks.current[index] = element
              }}
              className={styles.chapterTime}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              {chapter.time}
            </p>
            <h2 className={styles.chapterTitle}>{chapter.title}</h2>
            <p className={styles.chapterText}>{chapter.text}</p>
          </li>
        ))}
      </ol>
    </div>
  )
}

// CMS questions link to their own FAQ page; seed content renders as plain text.
function faqItems(items: AgentLandingView["faq"]["items"]): LandingFAQItem[] {
  return items.flatMap((item): LandingFAQItem[] => {
    if (typeof item === "number") return []
    if (typeof item.answer === "string")
      return [{ id: item.slug, question: item.question, answer: item.answer }]
    if ("_status" in item && item._status !== "published") return []
    return [
      {
        id: item.slug,
        question: item.question,
        answer: <CMSRichText data={item.answer} />,
        href: getFAQPath(item.slug),
      },
    ]
  })
}

export function AgentLandingPage({ page }: { page: AgentLandingView }) {
  const { hero, whatsapp, cta } = page
  const reduced = useReducedMotion() ?? false
  const rise = (delay: number) =>
    reduced
      ? {}
      : {
          initial: { opacity: 0, y: 24, filter: "blur(8px)" },
          animate: { opacity: 1, y: 0, filter: "blur(0px)" },
          transition: { duration: 0.9, delay, ease },
        }
  return (
    <div className={`${styles.page} ${accentFont.variable}`}>
      <Story
        story={page.story}
        channel={page.channel}
        intro={
          <section className={styles.hero}>
            <h1 className={styles.headline}>
              <motion.span className={styles.line} {...rise(0)}>
                {hero.title}
              </motion.span>
              {hero.accent && (
                <motion.em className={styles.line} {...rise(0.15)}>
                  {hero.accent}
                </motion.em>
              )}
            </h1>
            <motion.p className={styles.lede} {...rise(0.35)}>
              {hero.description}
            </motion.p>
            <motion.div className={styles.actions} {...rise(0.5)}>
              <WhatsAppAction whatsapp={whatsapp} label={hero.primaryLabel} />
            </motion.div>
            {hero.scrollLabel && (
              <motion.a
                href="#story"
                className={styles.scrollCue}
                {...rise(0.8)}
              >
                {hero.scrollLabel}
                <ArrowDown aria-hidden="true" />
              </motion.a>
            )}
          </section>
        }
      />

      <AgentLandingFeatures features={page.features} />

      <LandingFAQ
        className={styles.faq}
        title={page.faq.title}
        items={faqItems(page.faq.items)}
      />

      <motion.section
        className={styles.cta}
        initial={reduced ? false : { opacity: 0, y: 40 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.4 }}
        transition={{ duration: 0.9, ease }}
      >
        <h2 className={styles.ctaTitle}>{cta.title}</h2>
        {cta.description && (
          <p className={styles.ctaDescription}>{cta.description}</p>
        )}
        <div className={styles.ctaActions}>
          <WhatsAppAction
            whatsapp={whatsapp}
            label={cta.label}
            size="2xl"
            className={styles.ctaButton}
          />
          <p className={styles.ctaNumber}>
            {formatWhatsappNumber(whatsapp.number)}
          </p>
        </div>
      </motion.section>
    </div>
  )
}
