import Link from "next/link"
import { ArrowUpRight } from "lucide-react"
import type { Page } from "@/payload-types"
import {
  productFeatures,
  productPillars,
  type ProductPillar,
} from "@/lib/marketing/product"
import { productIcons } from "@/components/product-icons"
import { Button } from "@/components/ui/button"
import { ContentLink } from "@/components/ui/content-link"
import { safeHref } from "@/cms/access"
import { ProductPreview, FeatureVisual } from "./product-visuals"
import styles from "./product.module.css"

const chapters = {
  build: ["prompts", "playground", "integrations"],
  observe: ["traces", "agents", "dashboards"],
  evaluate: ["datasets", "scorers", "reviews"],
  discover: ["dashboards", "alerts"],
} as const
const questions = {
  build: "How do I turn a prompt into something that works?",
  observe: "Why did my AI give that answer?",
  evaluate: "Did my change actually make things better?",
  discover: "What needs my attention next?",
}
const takeaways = {
  build: [
    "A version you can name.",
    "A result you can inspect.",
    "A change you can test.",
  ],
  observe: [
    "The input that started it.",
    "The steps that produced it.",
    "The evidence to fix it.",
  ],
  evaluate: [
    "The same cases.",
    "A clear definition of good.",
    "A result you can defend.",
  ],
  discover: [
    "See the pattern.",
    "Narrow the question.",
    "Find the requests behind it.",
  ],
}

export function ProductPillarPage({
  page,
  pillar,
}: {
  page: Page
  pillar: ProductPillar
}) {
  const hero = page.layout[0]?.blockType === "hero" ? page.layout[0] : null
  const features = productFeatures.filter(
    (feature) =>
      feature.group === pillar.name ||
      (pillar.slug === "observe" && feature.slug === "dashboards")
  )
  const workflow = page.layout.find((block) => block.blockName === "workflow")
  const cta = page.layout.find((block) => block.blockType === "callToAction")
  return (
    <div className={styles.productPage}>
      <nav aria-label="Product pages" className={styles.pillarNav}>
        {productPillars.map((item, index) => (
          <Button
            asChild
            variant={item.slug === pillar.slug ? "secondary" : "ghost-muted"}
            size="xl"
            key={item.slug}
          >
            <Link
              href={`/product/${item.slug}`}
              aria-current={item.slug === pillar.slug ? "page" : undefined}
            >
              <span className={styles.navNumber}>0{index + 1}</span>
              <span className={styles.navLabel}>{item.name}</span>
            </Link>
          </Button>
        ))}
      </nav>
      <section className={styles.hero}>
        <div className={styles.heroGrid}>
          <h1>{hero?.title ?? page.title}</h1>
          <div className={styles.heroAside}>
            <p>{hero?.description}</p>
            <div className={styles.heroActions}>
              {hero?.actions
                ?.filter((action) => safeHref(action.href))
                .map((action, index) => (
                  <Button
                    asChild
                    key={action.id || index}
                    variant={index === 0 ? "marketing" : "link"}
                    size="lg"
                  >
                    <Link href={action.href}>
                      {action.label}
                      <ArrowUpRight aria-hidden="true" />
                    </Link>
                  </Button>
                ))}
            </div>
          </div>
        </div>
      </section>
      <section
        id={pillar.slug === "evaluate" ? "evaluations" : "walkthrough"}
        className={styles.walkthrough}
        aria-label={`${pillar.name} explained`}
      >
        <ProductPreview pillar={pillar} />
      </section>
      <section className={styles.thesis}>
        <div>
          <p className={styles.eyebrow}>THE QUESTION THAT MATTERS</p>
          <h2>{questions[pillar.slug]}</h2>
        </div>
        <div className={styles.takeaways}>
          {takeaways[pillar.slug].map((line, index) => (
            <p key={line}>
              <span>0{index + 1}</span>
              {line}
            </p>
          ))}
        </div>
      </section>
      <nav aria-label={`${pillar.name} features`} className={styles.featureNav}>
        {features
          .filter(
            (feature) =>
              pillar.slug !== "observe" || feature.slug !== "sessions"
          )
          .map((feature) => (
            <Button key={feature.slug} asChild variant="ghost" size="sm">
              <a href={`#${feature.slug}`}>
                {feature.name}
                <ArrowDownSmall />
              </a>
            </Button>
          ))}
      </nav>
      {chapters[pillar.slug].map((slug, index) => {
        const feature = productFeatures.find((item) => item.slug === slug)!
        const intro = page.layout.find((block) => block.blockName === slug)
        const capabilities = page.layout.find(
          (block) => block.blockName === `${slug}-capabilities`
        )
        if (intro?.blockType !== "hero") return null
        const Icon = productIcons[feature.icon]
        return (
          <section
            key={slug}
            id={slug}
            className={styles.chapter}
            data-reverse={index % 2 === 1}
          >
            {slug === "agents" && (
              <span id="workflows" className={styles.anchor} />
            )}
            {slug === "reviews" && (
              <span id="human-scores" className={styles.anchor} />
            )}
            <div className={styles.chapterCopy}>
              <p className={styles.eyebrow}>
                <Icon size={17} aria-hidden="true" />
                {slug === "agents"
                  ? "AGENTS & WORKFLOWS"
                  : slug === "reviews"
                    ? "REVIEWS & HUMAN SCORES"
                    : feature.name.toUpperCase()}
                <span className={styles.sectionNumber}>0{index + 2}</span>
              </p>
              <h2>{intro.title}</h2>
              <p className={styles.chapterLead}>{intro.description}</p>
              {capabilities?.blockType === "features" && (
                <div className={styles.chapterPoints}>
                  {capabilities.items.slice(0, 2).map((item, i) => (
                    <div key={item.id || i}>
                      <span>↳</span>
                      <div>
                        <h3>{item.title}</h3>
                        <p>{item.description}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <Button asChild variant="link" size="sm" className="px-0">
                <Link href={feature.docs}>
                  Explore {feature.name.toLowerCase()}
                  <ArrowUpRight size={15} aria-hidden="true" />
                </Link>
              </Button>
            </div>
            <div className={styles.chapterArt}>
              <FeatureVisual feature={slug} />
            </div>
          </section>
        )
      })}
      <section className={styles.featureIndex}>
        <p className={styles.eyebrow}>
          THE {pillar.name.toUpperCase()} TOOLKIT
        </p>
        <h2>
          {workflow?.blockType === "features"
            ? workflow.title
            : `Everything you need to ${pillar.slug}.`}
        </h2>
        <div className={styles.indexGrid}>
          {features.map((feature) => {
            const Icon = productIcons[feature.icon]
            return (
              <ContentLink
                key={feature.slug}
                href={feature.docs}
                variant="card"
                icon={<Icon aria-hidden="true" />}
                description={feature.summary}
              >
                <h3>{feature.name}</h3>
              </ContentLink>
            )
          })}
        </div>
      </section>
      <section className={styles.closing}>
        <p className={styles.eyebrow}>START WITH ONE REQUEST</p>
        <h2>
          {cta?.blockType === "callToAction"
            ? cta.title
            : "Make your next change a better one."}
        </h2>
        <Button asChild variant="marketing" size="lg">
          <Link href="/sign-up">
            Get started with Datool
            <ArrowUpRight />
          </Link>
        </Button>
      </section>
      <section
        className={styles.related}
        aria-label="Continue exploring Datool"
      >
        {productPillars
          .filter((item) => item.slug !== pillar.slug)
          .map((item) => {
            const Icon = productIcons[item.icon]
            return (
              <ContentLink
                key={item.slug}
                href={`/product/${item.slug}`}
                variant="card"
                icon={<Icon aria-hidden="true" />}
                description={item.summary}
              >
                <h3>{item.name}</h3>
              </ContentLink>
            )
          })}
      </section>
    </div>
  )
}
function ArrowDownSmall() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path d="M6 1v9m-4-4 4 4 4-4" />
    </svg>
  )
}
