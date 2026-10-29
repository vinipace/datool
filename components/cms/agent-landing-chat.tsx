"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  Bell,
  Bot,
  Lock,
  MessageCircle,
  ShoppingBag,
  Sparkles,
  Upload,
  UserRound,
} from "lucide-react"
import type { AgentLanding } from "@/payload-types"
import styles from "./agent-landing.module.css"

type Story = AgentLanding["story"]
type Message = Story["chapters"][number]["messages"][number]
type Item = { key: string; chapter: number; message: Message }
// Events happen outside the chat, so only conversation messages reach the thread.
type ChatItem = Item & {
  message: { from: Exclude<Message["from"], "event"> }
}
const isChat = (item: Item): item is ChatItem => item.message.from !== "event"

const senderLabel = { agent: "AI agent", human: "Your team" } as const
const spring = { type: "spring", stiffness: 420, damping: 32 } as const

function delayFor(item: Item) {
  if (item.message.from === "customer") return 650
  if (item.message.from === "event") return 550
  return Math.min(1500, 600 + item.message.text.length * 10)
}

function storyItems(chapters: Story["chapters"]) {
  return chapters.flatMap((chapter, index): Item[] =>
    chapter.messages.map((message, position) => ({
      key: `${index}-${position}`,
      message,
      chapter: index,
    }))
  )
}

// Store links read as links, like the chat apps they imitate.
const linkPattern = /([a-z0-9-]+(?:\.[a-z0-9-]+)+\/[^\s]*[^\s.,!?])/i
function withLinks(text: string) {
  return text.split(linkPattern).map((part, index) =>
    index % 2 ? (
      <span key={index} className={styles.chatLink}>
        {part}
      </span>
    ) : (
      part
    )
  )
}

function Thread({
  story,
  items,
  typing,
  reduced,
}: {
  story: Story
  items: ChatItem[]
  typing: boolean
  reduced: boolean
}) {
  const log = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = log.current
    if (element)
      element.scrollTo({ top: element.scrollHeight, behavior: "smooth" })
  }, [items.length, typing])
  const products = story.products ?? []
  return (
    <div
      ref={log}
      className={styles.chatLog}
      role="log"
      aria-label={`Conversation with ${story.contact}`}
    >
      <AnimatePresence initial={false}>
        {items.map((item) => (
          <motion.div
            key={item.key}
            layout={!reduced}
            initial={reduced ? false : { opacity: 0, y: 14, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
            transition={spring}
            className={styles.chatItem}
            data-from={item.message.from}
          >
            <p className={styles.bubble}>
              <span className="sr-only">
                {item.message.from === "customer"
                  ? story.contact
                  : senderLabel[item.message.from]}
                :{" "}
              </span>
              {withLinks(item.message.text)}
            </p>
            {item.message.showProducts && products.length > 0 && (
              <ul
                className={styles.chatProducts}
                aria-label="Recommended products"
              >
                {products.map((product, index) => (
                  <motion.li
                    key={product.id || index}
                    className={styles.chatProduct}
                    initial={reduced ? false : { opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.15 + index * 0.09 }}
                  >
                    <span
                      className={styles.productTile}
                      data-tone={product.tone}
                    >
                      <ShoppingBag aria-hidden="true" />
                    </span>
                    <span className={styles.chatProductName}>
                      {product.name}
                    </span>
                    <span className={styles.chatProductPrice}>
                      {product.price}
                    </span>
                  </motion.li>
                ))}
              </ul>
            )}
            {item.message.from !== "customer" && (
              <span className={styles.sender} aria-hidden="true">
                {item.message.from === "agent" ? <Bot /> : <UserRound />}
                {senderLabel[item.message.from]}
              </span>
            )}
          </motion.div>
        ))}
        {typing && (
          <motion.div
            key="typing"
            layout
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className={styles.chatItem}
            data-from="agent"
            aria-hidden="true"
          >
            <p className={`${styles.bubble} ${styles.typing}`}>
              <span />
              <span />
              <span />
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function WidgetHeader({ story, typing }: { story: Story; typing: boolean }) {
  return (
    <div className={styles.widgetHeader}>
      <span className={styles.widgetAvatar} aria-hidden="true">
        <Sparkles />
      </span>
      <span>
        <span className={styles.chatTitle}>{story.assistant}</span>
        <span className={styles.chatStatus}>
          {typing ? "Typing…" : "AI agent · replies instantly"}
        </span>
      </span>
    </div>
  )
}

function AddressBar({ site }: { site: string }) {
  return (
    <div className={styles.addressBar} aria-hidden="true">
      <span className={styles.dots}>
        <span />
        <span />
        <span />
      </span>
      <span className={styles.address}>
        <Lock />
        {site}
      </span>
    </div>
  )
}

// Reveals the conversation up to the active chapter, one message at a time,
// framed as the page's channel: a phone, a website or an app.
export function StoryDevice({
  story,
  channel,
  active,
}: {
  story: Story
  channel: AgentLanding["channel"]
  active: number
}) {
  const reduced = useReducedMotion() ?? false
  const items = useMemo(() => storyItems(story.chapters), [story.chapters])
  const target = items.filter((item) => item.chapter <= active).length
  // Earlier chapters appear at once, so a fast scroll never leaves the chat behind.
  const settled = items.filter((item) => item.chapter < active).length
  const [shown, setShown] = useState(0)
  // Scrolling back rewinds, so the chapter plays again on the way down.
  if (shown > target) setShown(target)
  const visible = reduced ? target : Math.min(Math.max(shown, settled), target)
  const next = items[visible]
  const typing =
    visible < target &&
    (next.message.from === "agent" || next.message.from === "human")
  useEffect(() => {
    if (reduced || visible >= target) return
    const timer = window.setTimeout(
      () => setShown(visible + 1),
      delayFor(items[visible])
    )
    return () => window.clearTimeout(timer)
  }, [items, reduced, target, visible])
  const thread = items.slice(0, visible)
  // The highlight stays on for the whole chapter that asked for it.
  const spotlight = thread.some(
    (item) => item.chapter === active && Boolean(item.message.highlight)
  )
  // The active chapter's latest event shows as a notification beside the device.
  const notice = thread.findLast(
    (item) => item.chapter === active && item.message.from === "event"
  )
  const conversation = (
    <Thread
      story={story}
      items={thread.filter(isChat)}
      typing={typing}
      reduced={reduced}
    />
  )

  return (
    <div className={styles.device} data-channel={channel}>
      <div className={styles.notices} role="status">
        <AnimatePresence>
          {notice && (
            <motion.div
              key={notice.key}
              className={styles.notice}
              initial={reduced ? false : { opacity: 0, y: -14, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, transition: { duration: 0.2 } }}
              transition={spring}
            >
              <span className={styles.noticeIcon} aria-hidden="true">
                <Bell />
              </span>
              <span>
                <span className={styles.noticeTitle}>
                  Datool<span aria-hidden="true"> · now</span>
                </span>
                <span className={styles.noticeText}>{notice.message.text}</span>
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {channel === "whatsapp" ? (
        <div className={styles.phone}>
          <span className={styles.phoneNotch} aria-hidden="true" />
          <div className={styles.chat}>
            <div className={styles.chatHeader}>
              <span className={styles.chatAvatar} aria-hidden="true">
                {story.contact.slice(0, 1)}
              </span>
              <span>
                <span className={styles.chatTitle}>{story.contact}</span>
                <span className={styles.chatStatus}>
                  {typing ? "AI agent is typing…" : "WhatsApp"}
                </span>
              </span>
            </div>
            {conversation}
          </div>
        </div>
      ) : (
        <div className={styles.window}>
          <AddressBar site={story.site} />
          <div className={styles.viewport}>
            {channel === "web" ? (
              <div className={styles.storefront} aria-hidden="true">
                <span className={styles.skeletonHero} />
                <span className={styles.skeletonRow}>
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            ) : (
              <div className={styles.appShell} aria-hidden="true">
                <span className={styles.appNav}>
                  <span />
                  <span />
                  <span />
                  <span />
                </span>
                <span className={styles.appMain}>
                  <span className={styles.appToolbar}>
                    <span className={styles.appHeading} />
                    <span
                      className={styles.appButton}
                      data-spotlight={spotlight}
                    >
                      <Upload />
                      Import
                    </span>
                  </span>
                  <span className={styles.appRows}>
                    <span />
                    <span />
                    <span />
                    <span />
                  </span>
                </span>
              </div>
            )}
            <div className={styles.widget}>
              <WidgetHeader story={story} typing={typing} />
              {conversation}
            </div>
            {channel === "web" && (
              <span className={styles.launcher} aria-hidden="true">
                <MessageCircle />
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
