import Link from "next/link"
import {
  ArrowRight,
  ArrowUpRight,
  Bot,
  Globe,
  Inbox,
  MessageCircle,
  PanelsTopLeft,
} from "lucide-react"
import type {
  CallToActionBlock,
  Faq,
  FaqBlock,
  FeaturesBlock,
  HeroBlock,
  Page,
} from "@/payload-types"
import { safeHref } from "@/cms/access"
import { getFAQPath } from "@/lib/cms/faq"
import { Button } from "@/components/ui/button"
import { ContentLink } from "@/components/ui/content-link"
import { getAgentPage } from "./agent-pages"
import { CMSRichText, PageBlocks } from "./page-blocks"
import { LandingFAQ } from "./landing-faq"
import { HomeQualityChart } from "./home-quality-chart"
import { PlatformTour } from "./platform-tour"
import { accentFont } from "./accent-font"
import styles from "./home.module.css"

function Actions({
  actions,
}: {
  actions: HeroBlock["actions"] | { label: string; href: string }[]
}) {
  return (
    <div className={styles.actions}>
      {actions
        ?.filter((action) => safeHref(action.href))
        .map((action, index) => (
          <Button
            asChild
            key={action.href}
            size="lg"
            variant={index === 0 ? "marketing" : "outline"}
          >
            <Link href={action.href}>
              {action.label}
              <ArrowUpRight aria-hidden="true" />
            </Link>
          </Button>
        ))}
    </div>
  )
}

const channels = [
  { label: "WhatsApp", Icon: MessageCircle },
  { label: "Website chat", Icon: Globe },
  { label: "Inside your app", Icon: PanelsTopLeft },
]

function Hero({ block }: { block: HeroBlock }) {
  // The last sentence of the title gets the accent line.
  const sentenceBreak = block.title.lastIndexOf(". ")
  return (
    <>
      <section className={styles.hero}>
        <h1 className={styles.headline}>
          {sentenceBreak >= 0 ? (
            <>
              {block.title.slice(0, sentenceBreak + 1)}{" "}
              <em>{block.title.slice(sentenceBreak + 2)}</em>
            </>
          ) : (
            block.title
          )}
        </h1>
        <p className={styles.description}>{block.description}</p>
        <Actions actions={block.actions} />
      </section>
      <PlatformTour />
    </>
  )
}

const tracing = [
  'import { createTracer } from "@datool/sdk"',
  "",
  "const tracer = createTracer()",
  "await tracer.workflow({ name, input }, run)",
]
const capabilities = ["Traces", "Scores", "Reviews", "Dashboards", "Alerts"]

// Each path ends in the same workspace, so the art previews what that path adds.
function PlatformArt({ index }: { index: number }) {
  if (index === 0)
    return (
      <pre className={styles.snippet} aria-hidden="true">
        <code>{tracing.join("\n")}</code>
      </pre>
    )
  if (index === 1)
    return (
      <div className={styles.channels} aria-hidden="true">
        {channels.map(({ label, Icon }) => (
          <span key={label}>
            <Icon /> {label}
          </span>
        ))}
        <span data-inbox>
          <Inbox /> Team inbox · 2 waiting
        </span>
      </div>
    )
  return (
    <>
      <HomeQualityChart className={styles.workspaceChart} />
      <ul className={styles.capabilities} aria-label="Included for every agent">
        {capabilities.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </>
  )
}

function Pillar({
  item,
  index,
}: {
  item: FeaturesBlock["items"][number]
  index: number
}) {
  return (
    <article className={styles.pillar} data-step={index}>
      <p className={styles.step} aria-hidden="true">
        {index < 2 ? `Path ${index + 1}` : "One workspace"}
      </p>
      <h3>
        {item.href && safeHref(item.href) ? (
          <Link href={item.href}>
            {item.title}
            <ArrowUpRight aria-hidden="true" />
          </Link>
        ) : (
          item.title
        )}
      </h3>
      <p>{item.description}</p>
      <PlatformArt index={index} />
    </article>
  )
}

function Platform({ block }: { block: FeaturesBlock }) {
  const [connect, build, ...rest] = block.items
  return (
    <section className={styles.band} data-tone="lilac">
      <p className={styles.eyebrow}>One platform</p>
      <h2 className={styles.heading}>{block.title}</h2>
      <div className={styles.platform}>
        <div className={styles.paths}>
          {[connect, build].filter(Boolean).map((item, index) => (
            <Pillar key={item.id || index} item={item} index={index} />
          ))}
        </div>
        <span className={styles.connector} aria-hidden="true">
          <ArrowRight />
          <ArrowRight />
        </span>
        {rest.map((item, index) => (
          <Pillar key={item.id || index} item={item} index={index + 2} />
        ))}
      </div>
    </section>
  )
}

function Agents({ block }: { block: FeaturesBlock }) {
  return (
    <section id="agents" className={`${styles.section} ${styles.agents}`}>
      <p className={styles.eyebrow}>Ready-made agents</p>
      <h2 className={styles.heading}>{block.title}</h2>
      <div className={styles.agentGrid}>
        {block.items.map((item, index) => {
          const Icon = getAgentPage(item.href ?? "")?.Icon ?? Bot
          return item.href && safeHref(item.href) ? (
            <ContentLink
              key={item.id || index}
              href={item.href}
              variant="card"
              icon={<Icon aria-hidden="true" />}
              description={item.description}
            >
              <h3>{item.title}</h3>
            </ContentLink>
          ) : null
        })}
      </div>
    </section>
  )
}

function Loop({ block }: { block: FeaturesBlock }) {
  return (
    <section className={styles.band} data-tone="leaf">
      <p className={styles.eyebrow}>How teams work</p>
      <h2 className={styles.heading}>{block.title}</h2>
      <ol className={styles.loop}>
        {block.items.map((item, index) => (
          <li key={item.id || index}>
            <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
            <h3>{item.title}</h3>
            <p>{item.description}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}

function Questions({ block, preview }: { block: FaqBlock; preview: boolean }) {
  const items = (block.items ?? []).filter(
    (item): item is Faq =>
      typeof item === "object" &&
      item !== null &&
      (preview || item._status === "published")
  )
  return (
    <LandingFAQ
      className={styles.questions}
      title={block.title}
      items={items.map((faq) => ({
        id: faq.slug,
        question: faq.question,
        answer: <CMSRichText data={faq.answer} />,
        href: getFAQPath(faq.slug),
      }))}
    />
  )
}

// Stepped columns that rise toward the middle, in percent of the skyline.
const skyline = [12, 22, 34, 48, 62, 76, 84, 84, 76, 62, 48, 34, 22, 12]

function CallToAction({ block }: { block: CallToActionBlock }) {
  return (
    <section className={styles.closing}>
      <div className={styles.cta}>
        <h2>{block.title}</h2>
        {block.description && <p>{block.description}</p>}
        {safeHref(block.href) && (
          <Button asChild size="lg" variant="marketing">
            <Link href={block.href}>
              {block.label}
              <ArrowUpRight aria-hidden="true" />
            </Link>
          </Button>
        )}
      </div>
      <div className={styles.skyline} aria-hidden="true">
        <div>
          {skyline.map((height, index) => (
            <span
              key={index}
              style={{
                height: `${height}%`,
                animationDelay: `${index * 50}ms`,
              }}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

// The home page sells the whole platform in light, colored bands. Features
// blocks named "platform", "agents" and "loop" get their own layouts; other
// blocks render as usual.
export function HomePage({
  blocks,
  preview = false,
}: {
  blocks: Page["layout"]
  preview?: boolean
}) {
  return (
    <div className={`${styles.home} ${accentFont.variable}`}>
      {blocks.map((block, index) => {
        const key = block.id || index
        if (block.blockType === "hero" && index === 0)
          return <Hero key={key} block={block} />
        if (block.blockType === "callToAction")
          return <CallToAction key={key} block={block} />
        if (block.blockType === "faq")
          return <Questions key={key} block={block} preview={preview} />
        if (block.blockType === "features") {
          if (block.blockName === "platform")
            return <Platform key={key} block={block} />
          if (block.blockName === "agents")
            return <Agents key={key} block={block} />
          if (block.blockName === "loop")
            return <Loop key={key} block={block} />
        }
        return <PageBlocks key={key} blocks={[block]} preview={preview} />
      })}
    </div>
  )
}
