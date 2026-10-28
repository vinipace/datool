"use client"

import { motion, useReducedMotion } from "motion/react"
import {
  Ban,
  Bot,
  Check,
  FileText,
  Globe,
  Megaphone,
  MessageCircle,
  ShoppingBag,
  Sparkles,
  Upload,
  UserRound,
} from "lucide-react"
import type { AgentLanding } from "@/payload-types"
import styles from "./agent-landing-features.module.css"

type Feature = AgentLanding["features"]["items"][number]

const ease = [0.22, 1, 0.36, 1] as const

// Each tile carries a small illustration of the feature instead of an icon.
function Visual({ visual }: { visual: Feature["visual"] }) {
  switch (visual) {
    case "whatsapp":
      return (
        <div className={styles.channels}>
          <div className={styles.miniPhone} data-size="large">
            <span className={styles.miniHeader}>
              <MessageCircle aria-hidden="true" />
              WhatsApp
            </span>
            <span className={styles.bubbleIn}>Do you ship to Recife?</span>
            <span className={styles.bubbleOut}>
              Yes, in 3 business days. Free over R$ 299.
            </span>
            <span className={styles.bubbleIn}>Perfect, ordering now.</span>
            <span className={styles.bubbleOut}>Here's your checkout link.</span>
          </div>
        </div>
      )
    case "website":
      return (
        <div className={styles.channels}>
          <div className={styles.browser} data-size="large">
            <span className={styles.browserBar}>
              <Globe aria-hidden="true" />
              yourstore.com
            </span>
            <span className={styles.bubbleIn}>Do you ship to Recife?</span>
            <span className={styles.bubbleOut}>
              Yes, in 3 business days. Free over R$ 299.
            </span>
            <span className={styles.bubbleIn}>Perfect, ordering now.</span>
            <span className={styles.launcher}>
              <MessageCircle aria-hidden="true" />
            </span>
          </div>
        </div>
      )
    case "inproduct":
      return (
        <div className={styles.inproduct}>
          <span className={styles.appFrame}>
            <span className={styles.appSide}>
              <span />
              <span />
              <span />
            </span>
            <span className={styles.appBody}>
              <span />
              <span />
              <span />
            </span>
          </span>
          <span className={styles.panel}>
            <span className={styles.panelHeader}>
              <Sparkles aria-hidden="true" />
              Guide
            </span>
            <span className={styles.bubbleIn}>Where do I add a teammate?</span>
            <span className={styles.bubbleOut}>
              Settings → Members. Opening it now.
            </span>
          </span>
        </div>
      )
    case "spotlight":
      return (
        <div className={styles.spotlight}>
          <span className={styles.ghostButton} />
          <span className={styles.ghostButton} />
          <span className={styles.target}>
            <Upload aria-hidden="true" />
            Import
            <span className={styles.tip}>Start here</span>
          </span>
        </div>
      )
    case "catalog":
      return (
        <div className={styles.catalog}>
          {(["leaf", "lilac", "peach"] as const).map((tone, index) => (
            <span key={tone} className={styles.product} data-tone={tone}>
              <ShoppingBag aria-hidden="true" />
              <span className={styles.productMeta}>
                <span>Size 38</span>
                <span className={styles.stock}>
                  {index === 2 ? "2 left" : "In stock"}
                </span>
              </span>
            </span>
          ))}
        </div>
      )
    case "handoff":
      return (
        <div className={styles.handoff}>
          <span className={styles.avatar} data-kind="agent">
            <Bot aria-hidden="true" />
          </span>
          <span className={styles.handoffLine} />
          <span className={styles.avatar} data-kind="human">
            <UserRound aria-hidden="true" />
          </span>
        </div>
      )
    case "knowledge":
      return (
        <div className={styles.doc}>
          <span className={styles.docTitle}>
            <FileText aria-hidden="true" />
            Help center
          </span>
          <span className={styles.docLine} />
          <span className={styles.docLine} data-highlight="true" />
          <span className={styles.docLine} data-short="true" />
        </div>
      )
    case "actions":
      return (
        <ul className={styles.actions}>
          {["lookup_account", "open_ticket", "call_your_api"].map((name) => (
            <li key={name}>
              <code>{name}</code>
              <Check aria-hidden="true" />
            </li>
          ))}
        </ul>
      )
    case "widgets":
      return (
        <div className={styles.widget}>
          {["36", "37", "38", "39"].map((size) => (
            <span key={size} data-selected={size === "38"}>
              {size}
            </span>
          ))}
        </div>
      )
    case "leads":
      return (
        <div className={styles.lead}>
          <span className={styles.leadAvatar}>A</span>
          <span className={styles.leadRows}>
            <span>Ana · São Paulo</span>
            <span className={styles.tag}>Running shoes</span>
          </span>
        </div>
      )
    case "campaigns":
      return (
        <div className={styles.campaign}>
          <Megaphone aria-hidden="true" />
          <span className={styles.bubbleOut}>
            Trail Flex is back in size 38.
          </span>
        </div>
      )
    case "guardrails":
      return (
        <div className={styles.guardrail}>
          <span className={styles.bubbleIn}>Can I get 50% off?</span>
          <span className={styles.blocked}>
            <Ban aria-hidden="true" />
            Discounts need approval
          </span>
        </div>
      )
    case "analytics":
      return (
        <div className={styles.chart}>
          {[38, 52, 47, 61, 58, 72, 69, 84].map((height, index) => (
            <span key={index} style={{ height: `${height}%` }} />
          ))}
        </div>
      )
  }
}

export function AgentLandingFeatures({
  features,
}: {
  features: AgentLanding["features"]
}) {
  const reduced = useReducedMotion() ?? false
  return (
    <section className={styles.features} aria-labelledby="commerce-features">
      <motion.h2
        id="commerce-features"
        className={styles.title}
        initial={reduced ? false : { opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.6 }}
        transition={{ duration: 0.8, ease }}
      >
        {features.title}
        {features.accent && <em> {features.accent}</em>}
      </motion.h2>
      <ul className={styles.grid}>
        {features.items.map((feature, index) => (
          <motion.li
            key={feature.id || index}
            className={styles.tile}
            data-size={feature.size}
            data-visual={feature.visual}
            initial={reduced ? false : { opacity: 0, y: 32, scale: 0.98 }}
            whileInView={{ opacity: 1, y: 0, scale: 1 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.7, delay: (index % 4) * 0.08, ease }}
          >
            <div className={styles.visual} aria-hidden="true">
              <Visual visual={feature.visual} />
            </div>
            <h3 className={styles.tileTitle}>{feature.title}</h3>
            <p className={styles.tileText}>{feature.text}</p>
          </motion.li>
        ))}
      </ul>
    </section>
  )
}
