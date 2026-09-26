import Link from "next/link"
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  Check,
  Code2,
  Database,
  FlaskConical,
  Octagon,
  Square,
  Triangle,
  Wrench,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { productFeatures, productFeatureHref } from "@/lib/marketing/product"
import { cloudPlans, formatUsd, type CloudPrices } from "@/src/lib/billing"
import { executionAllowances, formatCredits } from "@/src/lib/execution-credits"
import styles from "./pricing.module.css"
import { PricingPlanAction } from "@/components/workspace/pricing-checkout"

type Feature = { name: string; href: string; description?: string }

function featuresFor(
  group: (typeof productFeatures)[number]["group"]
): Feature[] {
  return productFeatures
    .filter(
      (feature) => feature.group === group && feature.slug !== "integrations"
    )
    .map((feature) => ({
      name: feature.name,
      href: productFeatureHref(feature),
      description: feature.summary,
    }))
}

// Core and Pro share product access. Volume and retention come from billing.
const featureGroups = [
  {
    id: "observe",
    name: "Observability",
    icon: Activity,
    features: [
      ...featuresFor("Observe"),
      {
        name: "Inputs, outputs, errors, and span timing",
        href: "/docs/tracing/investigation",
      },
      {
        name: "Token usage and cost estimates",
        href: "/docs/tracing/investigation#read-usage-and-cost",
      },
      {
        name: "Filters and saved views",
        href: "/docs/tracing/investigation#find-an-execution",
      },
    ],
  },
  {
    id: "build",
    name: "Build and experiment",
    icon: Wrench,
    features: [
      ...featuresFor("Build"),
      {
        name: "Immutable prompt versions",
        href: "/docs/guides/prompts#publish-versions",
      },
      {
        name: "Prompt variables and previews",
        href: "/docs/guides/prompts#variables-and-preview",
      },
      {
        name: "Local and HTTP app connections",
        href: "/docs/guides/playground",
      },
    ],
  },
  {
    id: "evaluate",
    name: "Evaluation and human review",
    icon: FlaskConical,
    features: [
      ...featuresFor("Evaluate"),
      {
        name: "Immutable dataset snapshots",
        href: "/docs/evaluation/datasets#preserve-evaluation-evidence",
      },
      {
        name: "Turn traces into dataset cases",
        href: "/docs/evaluation/datasets#promote-a-production-span",
      },
      {
        name: "JavaScript and Python scorers",
        href: "/docs/evaluation/scorers",
      },
      {
        name: "LLM judges and library scorers",
        href: "/docs/evaluation/scorers",
      },
      {
        name: "Re-score saved evidence",
        href: "/docs/evaluation/runs#re-score-or-run-again",
      },
      {
        name: "Replay apps on frozen cases",
        href: "/docs/evaluation/runs#re-score-or-run-again",
      },
      {
        name: "Run and case comparison",
        href: "/docs/evaluation/runs#compare-results",
      },
      {
        name: "CI quality gates",
        href: "/docs/evaluation/runs#run-from-the-cli",
      },
    ],
  },
  {
    id: "monitor",
    name: "Monitoring and analytics",
    icon: BarChart3,
    features: [
      ...featuresFor("Discover"),
      {
        name: "Custom charts and metric filters",
        href: "/docs/guides/dashboards",
      },
      {
        name: "In-app and webhook alerts",
        href: "/docs/guides/alerts#choose-a-destination",
      },
    ],
  },
  {
    id: "integrations",
    name: "Integrations and workspace",
    icon: Code2,
    features: [
      { name: "Node.js SDK", href: "/docs/reference/sdk" },
      { name: "Command-line interface", href: "/docs/reference/cli" },
      { name: "MCP for AI assistants", href: "/docs/reference/mcp" },
      {
        name: "OpenTelemetry and AI SDK tracing",
        href: "/docs/tracing/instrumentation",
      },
      {
        name: "Scoped organization API keys",
        href: "/docs/reference/authentication#organization-api-keys",
      },
      {
        name: "Organizations and projects",
        href: "/docs/get-started/concepts#organizations-and-projects",
      },
    ],
  },
]

function Included() {
  return (
    <span className={styles.included}>
      <Check aria-hidden="true" className="size-5" />
      <span className="sr-only">Included</span>
    </span>
  )
}

export function FeatureComparison({
  prices,
  executionEnabled = false,
  billingEnabled = false,
  contactHref,
}: {
  prices: CloudPrices | null
  executionEnabled?: boolean
  billingEnabled?: boolean
  contactHref?: string
}) {
  return (
    <section
      id="compare-plans"
      aria-labelledby="comparison-heading"
      className={styles.comparison}
    >
      <div className={styles.comparisonIntro}>
        <h2 id="comparison-heading">Compare every feature.</h2>
        <p>
          Every product feature is included in Core and Pro. Choose the record
          volume, retention{executionEnabled ? ", and execution credits" : ""}{" "}
          your team needs, or talk to us about Custom.
        </p>
      </div>
      <p
        id="comparison-scroll-hint"
        className="mb-4 text-xs text-foreground-muted md:hidden"
      >
        Scroll across to compare plans. Feature names stay in view.
      </p>
      <div
        className={styles.comparisonScroll}
        tabIndex={0}
        role="region"
        aria-label="Plan feature comparison"
        aria-describedby="comparison-scroll-hint"
      >
        <table className={styles.comparisonTable}>
          <caption className="sr-only">
            Features and allowances for Datool Core, Pro, and Custom
          </caption>
          <colgroup>
            <col className={styles.featureColumn} />
            <col />
            <col />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className={styles.featureHeading}>
                Features and limits
              </th>
              {cloudPlans.map((plan) => {
                const Icon = plan.id === "pro" ? Square : Triangle
                return (
                  <th
                    key={plan.id}
                    scope="col"
                    className={plan.id === "pro" ? styles.proColumn : undefined}
                  >
                    <span className={styles.comparisonPlanName}>
                      <Icon aria-hidden="true" className="size-5" />
                      {plan.name}
                    </span>
                    <p className={styles.comparisonPrice}>
                      {prices
                        ? `${formatUsd(prices[plan.id].amount)} / month`
                        : "Cloud pricing"}
                    </p>
                    <PricingPlanAction
                      plan={plan.id}
                      billingEnabled={billingEnabled}
                      size="sm"
                      className="w-full"
                    />
                  </th>
                )
              })}
              <th scope="col">
                <span className={styles.comparisonPlanName}>
                  <Octagon aria-hidden="true" className="size-5" />
                  Custom
                </span>
                <p className={styles.comparisonPrice}>Let’s talk</p>
                {contactHref && (
                  <Button asChild size="sm" className="w-full">
                    <a href={contactHref}>
                      Contact us <ArrowUpRight aria-hidden="true" />
                    </a>
                  </Button>
                )}
              </th>
            </tr>
          </thead>
          <tbody aria-labelledby="comparison-usage">
            <tr className={styles.comparisonGroup}>
              <th colSpan={4} scope="rowgroup" id="comparison-usage">
                <span>
                  <Database aria-hidden="true" className="size-5" />
                  Usage and retention
                </span>
              </th>
            </tr>
            <tr>
              <th scope="row">Trace and span records / month</th>
              {cloudPlans.map((plan) => (
                <td
                  key={plan.id}
                  className={plan.id === "pro" ? styles.proColumn : undefined}
                >
                  {plan.monthlyRecords.toLocaleString("en-US")}
                </td>
              ))}
              <td>Custom volume</td>
            </tr>
            <tr>
              <th scope="row">Trace retention</th>
              {cloudPlans.map((plan) => (
                <td
                  key={plan.id}
                  className={plan.id === "pro" ? styles.proColumn : undefined}
                >
                  {plan.retentionDays} days
                </td>
              ))}
              <td>Tailored retention</td>
            </tr>
            <tr>
              <th scope="row">
                Preserve saved evidence
                <p className={styles.featureDescription}>
                  Traces kept in datasets, evaluations, or reviews.
                </p>
              </th>
              <td>
                <Included />
              </td>
              <td className={styles.proColumn}>
                <Included />
              </td>
              <td>
                <Included />
              </td>
            </tr>
          </tbody>
          {executionEnabled && (
            <tbody aria-labelledby="comparison-execution">
              <tr className={styles.comparisonGroup}>
                <th colSpan={4} scope="rowgroup" id="comparison-execution">
                  <span>
                    <Code2 aria-hidden="true" className="size-5" />
                    Managed execution
                  </span>
                </th>
              </tr>
              <tr>
                <th scope="row">
                  Execution credits / paid month
                  <p className={styles.featureDescription}>
                    Shared across your organization. No rollover or automatic
                    overage.
                  </p>
                </th>
                <td>{formatCredits(executionAllowances.core)} USD</td>
                <td className={styles.proColumn}>
                  {formatCredits(executionAllowances.pro)} USD
                </td>
                <td>Agreed with your team</td>
              </tr>
              {[
                "Datool Scorer Model · GPT-6 Luna",
                "Datool Sandbox · JavaScript and Python",
              ].map((name) => (
                <tr key={name}>
                  <th scope="row">
                    {name}
                    <p className={styles.featureDescription}>
                      No provider key needed. Uses execution credits.
                    </p>
                  </th>
                  <td>
                    <Included />
                  </td>
                  <td className={styles.proColumn}>
                    <Included />
                  </td>
                  <td>
                    <Included />
                  </td>
                </tr>
              ))}
            </tbody>
          )}
          {featureGroups.map((group) => {
            const Icon = group.icon
            return (
              <tbody key={group.id} aria-labelledby={`comparison-${group.id}`}>
                <tr className={styles.comparisonGroup}>
                  <th
                    colSpan={4}
                    scope="rowgroup"
                    id={`comparison-${group.id}`}
                  >
                    <span>
                      <Icon aria-hidden="true" className="size-5" />
                      {group.name}
                    </span>
                  </th>
                </tr>
                {group.features.map((feature: Feature) => (
                  <tr key={feature.name}>
                    <th scope="row">
                      <Button
                        asChild
                        variant="link"
                        className="h-auto justify-start p-0 text-left font-normal whitespace-normal"
                      >
                        <Link href={feature.href}>{feature.name}</Link>
                      </Button>
                      {feature.description && (
                        <p className={styles.featureDescription}>
                          {feature.description}
                        </p>
                      )}
                    </th>
                    <td>
                      <Included />
                    </td>
                    <td className={styles.proColumn}>
                      <Included />
                    </td>
                    <td>
                      <Included />
                    </td>
                  </tr>
                ))}
              </tbody>
            )
          })}
        </table>
      </div>
      <p className="mt-5 text-sm leading-relaxed text-foreground-muted">
        {executionEnabled
          ? "Datool-managed scorers and sandboxes use your included execution credits. Other model usage and your own configured providers are billed separately by those providers."
          : "AI model and sandbox compute costs are billed separately by your providers."}{" "}
        Custom plan limits are agreed with your team.
      </p>
    </section>
  )
}
