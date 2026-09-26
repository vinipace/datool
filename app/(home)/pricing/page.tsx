import {
  ArrowUpRight,
  ArrowDown,
  Octagon,
  Square,
  Triangle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { FAQList } from "@/components/ui/faq-list"
import { Notice } from "@/components/ui/notice"
import { cmsMetadata } from "@/lib/cms/metadata"
import {
  cloudPlans,
  formatUsd,
  paymentGraceDays,
  type CloudPrices,
} from "@/src/lib/billing"
import { billingEnabled, cloudPrice } from "@/src/server/billing/config"
import { managedRuntimeConfigured } from "@/src/server/execution-credits/config"
import { executionAllowances, formatCredits } from "@/src/lib/execution-credits"
import styles from "./pricing.module.css"
import { FeatureComparison } from "./feature-comparison"
import { getPricingOnboarding } from "@/lib/pricing-onboarding"
import {
  PricingCheckout,
  PricingPlanAction,
} from "@/components/workspace/pricing-checkout"
import { OnboardingAccount } from "@/components/auth/onboarding-account"
import { MarketingShell } from "@/components/cms/marketing-shell"
import { notFound } from "next/navigation"
import { cmsEnabled } from "@/lib/cms/config"

export const dynamic = "force-dynamic"
export const metadata = cmsMetadata(
  {
    title: "Pricing",
    seo: {
      description:
        "Compare Core, Pro, and Custom plans for Datool Cloud. Choose monthly billing in USD or talk to us about a plan for your team.",
    },
  },
  "/pricing"
)

const includedFeatures = [
  {
    label: "Observability",
    value: "Traces, spans, sessions, dashboards, and cost insights",
  },
  {
    label: "Evaluation tools",
    value: "Datasets, scorers, evaluations, prompts, and version comparison",
  },
  {
    label: "Developer access",
    value: "SDK, CLI, and MCP",
  },
]

const pricingFAQs = [
  {
    id: "plan-differences",
    question: "What’s the difference between Core, Pro, and Custom?",
    content: `${cloudPlans
      .map(
        (plan) =>
          `${plan.name} includes ${plan.monthlyRecords.toLocaleString("en-US")} records per month and ${plan.retentionDays}-day trace retention.`
      )
      .join(
        " "
      )} Core and Pro include all product features. For higher volumes or different requirements, contact us about Custom.`,
  },
  {
    id: "record-counting",
    question: "What counts as a record?",
    content:
      "A record is one newly stored trace or span. Updates and retries do not count again.",
  },
  {
    id: "provider-costs",
    question: "Are AI model and sandbox costs included?",
    content:
      "AI provider and sandbox compute charges are separate, through your own provider accounts.",
  },
  {
    id: "record-limits",
    question: "What happens when I reach my monthly limit?",
    content:
      "New records pause at your limit, while existing data stays readable. Datool does not add usage overage charges for these plans. Your allowance resets on the first day of each month at 00:00 UTC.",
  },
  {
    id: "data-retention",
    question: "How does trace retention work?",
    content:
      "Retention starts when a trace is received. Traces saved in datasets, evaluations, or reviews are preserved. If you downgrade, the shorter retention period applies when the new plan takes effect.",
  },
  {
    id: "manage-subscription",
    question: "Can I cancel or update my payment method?",
    content:
      "You can manage payment methods and cancel your subscription from Billing. If you cancel, access continues until the end of the paid period.",
  },
  {
    id: "failed-renewal",
    question: "What happens if a renewal payment fails?",
    content: `Failed renewals have a ${paymentGraceDays}-day payment grace period. You can update your payment method from Billing.`,
  },
]

export default async function PricingPage() {
  if (!cmsEnabled()) notFound()
  const onboarding = await getPricingOnboarding()
  const enabled = billingEnabled()
  const contactEmail = process.env.DATOOL_CONTACT_EMAIL?.trim()
  const contactHref = contactEmail
    ? `mailto:${encodeURIComponent(contactEmail)}?subject=Datool%20custom%20plan`
    : undefined
  const executionEnabled =
    managedRuntimeConfigured("model") && managedRuntimeConfigured("sandbox")
  const faqs = executionEnabled
    ? pricingFAQs.map((item) =>
        item.id === "provider-costs"
          ? {
              ...item,
              content: `Core includes US$${executionAllowances.core} and Pro includes US$${executionAllowances.pro} in execution credits per paid month, shared by Datool Scorer Model and Datool Sandbox across your organization. No provider key is needed for these options. Credits expire at the end of the paid period, do not roll over, and have no automatic overage. When credits run out, funded runs pause. You can explicitly choose your own provider, whose charges are separate. Trial periods do not include execution credits.`,
            }
          : item
      )
    : pricingFAQs
  let prices: CloudPrices | null = null
  if (enabled) {
    try {
      const [core, pro] = await Promise.all([
        cloudPrice("core"),
        cloudPrice("pro"),
      ])
      prices = { core, pro }
    } catch {
      /* Show an honest unavailable state instead of a stale price. */
    }
  }
  return (
    <MarketingShell
      onboardingAccount={
        onboarding ? <OnboardingAccount email={onboarding.email} /> : undefined
      }
    >
      <PricingCheckout
        onboarding={
          onboarding
            ? {
                organizationId: onboarding.organization.id,
                canManage: onboarding.canManage,
                pricesAvailable: !!prices,
              }
            : null
        }
      >
        <section className="py-16 sm:py-24">
          <div className="mx-auto mb-12 max-w-2xl text-center">
            <p className="mb-4 text-sm font-medium tracking-widest text-marketing-primary">
              {onboarding ? "COMPLETE YOUR SETUP" : "DATOOL CLOUD"}
            </p>
            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
              {onboarding ? (
                "Choose your plan"
              ) : (
                <>
                  Understand every run.
                  <br />
                  Build better AI.
                </>
              )}
            </h1>
            <p className="mt-6 text-lg text-foreground-muted">
              {onboarding
                ? `${onboarding.organization.name} is ready. Choose a plan and complete payment to create your first project.`
                : "Traces, evaluations, prompts, and cost insights in one workspace. Monthly subscriptions, billed in US dollars."}
            </p>
          </div>
          {!enabled ? (
            <Notice className="mx-auto mb-8 max-w-2xl">
              Cloud checkout is not enabled on this installation. Plan
              allowances are shown below; prices appear when Cloud billing is
              connected.
            </Notice>
          ) : null}
          {enabled && !prices ? (
            <Notice
              className="mx-auto mb-8 max-w-2xl"
              variant="error"
              role="alert"
            >
              Pricing is temporarily unavailable. Please reload to try again.
            </Notice>
          ) : null}
          <div
            className={`${styles.plans} ${executionEnabled ? styles.withCredits : ""}`}
          >
            <div className={styles.labels} aria-hidden="true">
              <div className={styles.labelIntro}>
                <h2>Find your fit.</h2>
                <p>
                  One workspace.
                  <br />
                  Every step of your AI.
                </p>
              </div>
              {[
                "Records / month",
                "Trace retention",
                ...(executionEnabled ? ["Execution credits / month"] : []),
                ...includedFeatures.map((feature) => feature.label),
              ].map((label) => (
                <div key={label} className={styles.labelRow}>
                  {label}
                </div>
              ))}
              <div />
            </div>
            {cloudPlans.map((plan) => (
              <article
                key={plan.id}
                aria-labelledby={`plan-${plan.id}`}
                className={`${styles.plan} ${plan.id === "pro" ? styles.featured : ""}`}
              >
                <div className={styles.intro}>
                  {plan.id === "pro" ? (
                    <Square className={styles.tierIcon} aria-hidden="true" />
                  ) : (
                    <Triangle className={styles.tierIcon} aria-hidden="true" />
                  )}
                  <h2 id={`plan-${plan.id}`} className={styles.name}>
                    {plan.name}
                  </h2>
                  <p className={styles.description}>{plan.description}</p>
                  <div className={styles.price}>
                    <p className={styles.amount}>
                      {prices
                        ? formatUsd(prices[plan.id].amount)
                        : "Cloud pricing"}
                    </p>
                    <p className={styles.cadence}>per organization / month</p>
                  </div>
                </div>
                <dl className={styles.detailRow}>
                  <dt className={styles.rowLabel}>Records / month</dt>
                  <dd>{plan.monthlyRecords.toLocaleString("en-US")} records</dd>
                </dl>
                <dl className={styles.detailRow}>
                  <dt className={styles.rowLabel}>Trace retention</dt>
                  <dd>{plan.retentionDays} days</dd>
                </dl>
                {executionEnabled && (
                  <dl className={styles.detailRow}>
                    <dt className={styles.rowLabel}>
                      Execution credits / month
                    </dt>
                    <dd>
                      {formatCredits(executionAllowances[plan.id])} USD for
                      scorers and sandboxes
                    </dd>
                  </dl>
                )}
                {includedFeatures.map((feature) => (
                  <dl key={feature.label} className={styles.detailRow}>
                    <dt className={styles.rowLabel}>{feature.label}</dt>
                    <dd>{feature.value}</dd>
                  </dl>
                ))}
                <div className={styles.actions}>
                  {prices?.[plan.id].trialDays ? (
                    <p className="text-xs text-foreground-muted">
                      {prices[plan.id].trialDays}-day trial for new subscribers.
                      Card required.
                    </p>
                  ) : null}
                  <PricingPlanAction
                    plan={plan.id}
                    billingEnabled={enabled}
                    size="lg"
                    shape="circle"
                  />
                </div>
              </article>
            ))}
            <article className={styles.plan} aria-labelledby="plan-custom">
              <div className={styles.intro}>
                <Octagon className={styles.tierIcon} aria-hidden="true" />
                <h2 id="plan-custom" className={styles.name}>
                  Custom
                </h2>
                <p className={styles.description}>
                  For teams with requirements of their own.
                </p>
                <div className={styles.price}>
                  <p className={styles.amount}>Let’s talk</p>
                  <p className={styles.cadence}>
                    a plan shaped around your team
                  </p>
                </div>
              </div>
              <div className={styles.customDetails}>
                <p>
                  Everything in Pro, with a plan built around your requirements.
                </p>
                <p>
                  Talk to us about higher record volumes, tailored trace
                  retention, and what your team needs to grow.
                </p>
              </div>
              {contactHref && (
                <div className={styles.actions}>
                  <Button asChild size="lg" shape="circle">
                    <a href={contactHref}>
                      Contact us <ArrowUpRight aria-hidden="true" />
                    </a>
                  </Button>
                </div>
              )}
            </article>
          </div>
          <div className="mt-8 flex justify-center">
            <Button asChild variant="link">
              <a href="#compare-plans">
                Compare all features <ArrowDown aria-hidden="true" />
              </a>
            </Button>
          </div>
          <FeatureComparison
            prices={prices}
            executionEnabled={executionEnabled}
            billingEnabled={enabled}
            contactHref={contactHref}
          />
          <section
            aria-labelledby="pricing-faq"
            className="mx-auto mt-20 max-w-3xl sm:mt-28"
          >
            <h2
              id="pricing-faq"
              className="mb-8 text-3xl font-medium tracking-tight"
            >
              Frequently asked questions
            </h2>
            <FAQList items={faqs} />
          </section>
        </section>
      </PricingCheckout>
    </MarketingShell>
  )
}
