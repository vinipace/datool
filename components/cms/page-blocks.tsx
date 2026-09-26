import Link from "next/link"
import { Fragment } from "react"
import { RichText } from "@payloadcms/richtext-lexical/react"
import { ArrowUpRight, GitBranch } from "lucide-react"
import type { Faq, Page } from "@/payload-types"
import { Button } from "@/components/ui/button"
import { FAQList as FAQDisclosureList } from "@/components/ui/faq-list"
import { safeHref } from "@/cms/access"
import { FeatureVisual, RequestStory, SignalLoop } from "./landing-visuals"
import { PlatformPreview } from "./platform-preview"
import styles from "./landing.module.css"

export function CMSRichText({ data }: { data: Faq["answer"] }) {
  return (
    <RichText
      data={data}
      className="space-y-4 leading-relaxed text-foreground-muted [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-4 [&_h2]:text-2xl [&_h2]:font-medium [&_h2]:text-foreground [&_h3]:text-xl [&_h3]:font-medium [&_h3]:text-foreground [&_li]:ml-5 [&_ol]:list-decimal [&_strong]:text-foreground [&_ul]:list-disc"
    />
  )
}

export function FAQList({ items }: { items: Faq[] }) {
  return (
    <FAQDisclosureList
      items={items.map((faq) => ({
        id: faq.slug,
        question: faq.question,
        content: <CMSRichText data={faq.answer} />,
      }))}
    />
  )
}

function Action({
  href,
  label,
  secondary = false,
}: {
  href: string
  label: string
  secondary?: boolean
}) {
  if (!safeHref(href)) return null
  return (
    <Button asChild size="lg" variant={secondary ? "outline" : "marketing"}>
      <Link href={href}>
        {label}
        <ArrowUpRight aria-hidden="true" />
      </Link>
    </Button>
  )
}

export function PageBlocks({
  blocks,
  preview = false,
  landing = false,
}: {
  blocks: Page["layout"]
  preview?: boolean
  landing?: boolean
}) {
  return (
    <>
      {(blocks ?? []).map((block, index) => {
        const key = block.id || index
        switch (block.blockType) {
          case "hero":
            if (landing && index === 0) {
              // Keep the CMS title intact; the last sentence gets the signal accent.
              const sentenceBreak = block.title.lastIndexOf(". ")
              return (
                <Fragment key={key}>
                  <section className={styles.hero}>
                    <div className={styles.heroCopy}>
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
                      <div className={styles.actions}>
                        {block.actions?.map((action, i) => (
                          <Action
                            key={action.id || i}
                            {...action}
                            secondary={i > 0}
                          />
                        ))}
                      </div>
                      <p className={styles.heroNote}>
                        <GitBranch size={13} aria-hidden="true" /> Traces.
                        Evaluations. A better next version.
                      </p>
                    </div>
                    <RequestStory />
                  </section>
                  <PlatformPreview />
                </Fragment>
              )
            }
            return (
              <section key={key} className="max-w-4xl py-20 sm:py-28">
                {block.eyebrow && (
                  <p className="mb-6 text-sm font-medium tracking-widest text-foreground-muted uppercase">
                    {block.eyebrow}
                  </p>
                )}
                {index === 0 ? (
                  <h1 className="text-5xl leading-tight font-semibold tracking-tight sm:text-7xl">
                    {block.title}
                  </h1>
                ) : (
                  <h2 className="text-4xl font-semibold tracking-tight sm:text-5xl">
                    {block.title}
                  </h2>
                )}
                <p className="mt-6 max-w-2xl text-lg leading-relaxed text-foreground-muted sm:text-xl">
                  {block.description}
                </p>
                <div className="mt-9 flex flex-wrap gap-3">
                  {block.actions?.map((action, i) => (
                    <Action
                      key={action.id || i}
                      {...action}
                      secondary={i > 0}
                    />
                  ))}
                </div>
              </section>
            )
          case "features":
            return (
              <section
                key={key}
                className={landing ? styles.section : "py-12 sm:py-16"}
              >
                {landing && (
                  <p className={styles.sectionEyebrow}>THE IMPROVEMENT LOOP</p>
                )}
                <h2
                  className={
                    landing
                      ? styles.sectionHeading
                      : "mb-8 text-3xl font-medium tracking-tight"
                  }
                >
                  {block.title}
                </h2>
                <div
                  className={
                    landing ? styles.features : "grid gap-4 md:grid-cols-3"
                  }
                >
                  {(block.items ?? []).map((item, i) => (
                    <article
                      key={item.id || i}
                      className={
                        landing
                          ? styles.feature
                          : "rounded-xl border border-border bg-muted p-6"
                      }
                    >
                      <p
                        aria-hidden="true"
                        className={
                          landing
                            ? styles.featureNumber
                            : "mb-10 text-sm text-foreground-muted"
                        }
                      >
                        {String(i + 1).padStart(2, "0")}
                      </p>
                      {landing && i < 3 && <FeatureVisual index={i} />}
                      <h3 className="mb-3 text-xl font-medium">{item.title}</h3>
                      <p className="leading-relaxed text-foreground-muted">
                        {item.description}
                      </p>
                    </article>
                  ))}
                </div>
              </section>
            )
          case "richContent":
            return (
              <section
                key={key}
                className={landing ? styles.evidence : "max-w-3xl py-12"}
              >
                {block.content && <CMSRichText data={block.content} />}
              </section>
            )
          case "faq": {
            const items = (block.items ?? []).filter(
              (item): item is Faq =>
                typeof item === "object" &&
                item !== null &&
                (preview || item._status === "published")
            )
            return (
              <section
                key={key}
                className={landing ? styles.faq : "py-12 sm:py-16"}
              >
                <h2
                  className={
                    landing
                      ? styles.sectionHeading
                      : "mb-8 text-3xl font-medium tracking-tight"
                  }
                >
                  {block.title}
                </h2>
                <FAQList items={items} />
              </section>
            )
          }
          case "callToAction":
            return (
              <section
                key={key}
                className={
                  landing
                    ? styles.cta
                    : "my-12 rounded-xl border border-border bg-muted p-8 sm:p-12"
                }
              >
                {landing && <SignalLoop />}
                <h2 className="text-3xl font-medium tracking-tight sm:text-4xl">
                  {block.title}
                </h2>
                {block.description && (
                  <p className="mt-4 max-w-2xl text-lg text-foreground-muted">
                    {block.description}
                  </p>
                )}
                <div className={landing ? styles.ctaActions : "mt-7"}>
                  <Action href={block.href} label={block.label} />
                </div>
              </section>
            )
          default: {
            const unsupported: never = block
            throw new Error(
              `Unsupported CMS block: ${JSON.stringify(unsupported)}`
            )
          }
        }
      })}
    </>
  )
}
