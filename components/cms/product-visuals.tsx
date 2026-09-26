"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  ArrowDown,
  Bot,
  Check,
  Database,
  GitBranch,
  MessagesSquare,
  Terminal,
  RotateCcw,
  Slack,
  X,
} from "lucide-react"
import type { ProductPillar } from "@/lib/marketing/product"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { CodeEditor } from "@/components/ui/code-editor"
import { FormRow } from "@/components/ui/form-row"
import { InspectorSection } from "@/components/ui/inspector-section"
import { MessageTranscript } from "@/components/ui/message-transcript"
import { ModelProviderLogo } from "@/components/ui/model-provider-logo"
import { ScorerTypeBadge } from "@/components/ui/scorer-type-badge"
import { AnimatedDiagram } from "./animated-diagram"
import { ProductTraceExample } from "./product-trace-example"
import { ProductDashboardExample } from "./product-dashboard-example"
import styles from "./product.module.css"

const question = "Can I return my order after 45 days?"
const wrongAnswer = "Yes! You can return your order within 60 days."
const rightAnswer =
  "The return window is 30 days, so an order delivered 45 days ago is outside the policy. [1]"

function Label({ children }: { children: React.ReactNode }) {
  return <p className={styles.diagramLabel}>{children}</p>
}

/** A single flowing connector, shared by the explanatory diagrams. */
function Connector({ split = false }: { split?: boolean }) {
  return (
    <svg className={styles.connector} viewBox="0 0 100 160" aria-hidden="true">
      <path
        d={
          split
            ? "M0 80H30C70 80 30 30 80 30H96 M30 80C70 80 30 130 80 130H96"
            : "M0 80H96"
        }
      />
      {split ? (
        <>
          <path d="m88 22 8 8-8 8 M88 122l8 8-8 8" />
        </>
      ) : (
        <path d="m88 72 8 8-8 8" />
      )}
    </svg>
  )
}

function BuildDemo() {
  return (
    <Tabs defaultValue="v2">
      <div className={styles.demoControls}>
        <span>One question. Two instructions.</span>
        <TabsList aria-label="Prompt version">
          <TabsTrigger value="v1">Original prompt</TabsTrigger>
          <TabsTrigger value="v2">With context</TabsTrigger>
        </TabsList>
      </div>
      {["v1", "v2"].map((version) => (
        <TabsContent key={version} value={version}>
          <AnimatedDiagram className={`${styles.canvas} ${styles.buildCanvas}`}>
            <div className={styles.canvasTop}>
              <span>01 / CHANGE THE INSTRUCTION</span>
              <span>SUPPORT AGENT</span>
            </div>
            <div className={styles.promptFlow}>
              <div className={styles.instruction}>
                <MessagesSquare size={28} strokeWidth={1.5} />
                <Label>system / {version}</Label>
                <p>Answer the customer’s question.</p>
                {version === "v2" ? (
                  <p className={styles.highlightText}>
                    Use only the supplied policy.
                    <br />
                    Cite the source in your answer.
                  </p>
                ) : (
                  <p className={styles.softText}>No source. No constraints.</p>
                )}
                <div className={styles.promptVariable}>
                  <span>{"{{question}}"}</span>
                  <span>{version === "v2" ? "{{policy}}" : "—"}</span>
                </div>
              </div>
              <Connector />
              <div className={styles.outputCard}>
                <MessageTranscript
                  variant="bubbles"
                  messages={[
                    { role: "user", content: question, toolCalls: [] },
                    {
                      role: "assistant",
                      content: version === "v2" ? rightAnswer : wrongAnswer,
                      toolCalls: [],
                    },
                  ]}
                />
                <div className={styles.answerStatus}>
                  {version === "v2" ? (
                    <>
                      <Check size={17} /> Grounded in the supplied policy
                    </>
                  ) : (
                    <>
                      <X size={17} /> Confident answer. Wrong policy.
                    </>
                  )}
                </div>
              </div>
            </div>
            <div className={styles.canvasBottom}>
              <span>
                {version === "v2"
                  ? "A small prompt change. A traceable difference."
                  : "A plausible answer is not always a correct answer."}
              </span>
              <span>TRY THE TWO VERSIONS ↑</span>
            </div>
          </AnimatedDiagram>
        </TabsContent>
      ))}
    </Tabs>
  )
}

function ObserveDemo() {
  return (
    <div>
      <div className={styles.demoControls}>
        <span>Follow the answer back to its source.</span>
        <span className={styles.sampleTag}>SELECT A SPAN TO INSPECT IT</span>
      </div>
      <ProductTraceExample />
    </div>
  )
}

function CaseGrid({ pass, processed }: { pass: number; processed: number }) {
  return (
    <div
      className={styles.caseGrid}
      role="img"
      aria-label={`${Math.min(pass, processed)} passed, ${processed} of 24 cases checked`}
    >
      {Array.from({ length: 24 }, (_, i) => (
        <span
          key={i}
          data-pass={i < pass}
          data-checked={i < processed}
          aria-hidden="true"
        >
          {i < processed ? (
            i < pass ? (
              <Check size={15} />
            ) : (
              <X size={15} />
            )
          ) : null}
        </span>
      ))}
    </div>
  )
}
const evaluationCases = [
  {
    id: "returns",
    label: "Return policy",
    input: question,
    before: wrongAnswer,
    after: rightAnswer,
    improved: true,
  },
  {
    id: "source",
    label: "Missing source",
    input: "Can you show me where the policy says that?",
    before: "That is our standard policy.",
    after:
      "The return window is 30 days. Source: Returns policy, section 2. [1]",
    improved: true,
  },
  {
    id: "unknown",
    label: "Unknown answer",
    input: "Can I return a custom-made item?",
    before: "Yes, within 30 days.",
    after: "Yes, within 30 days. [1]",
    improved: false,
  },
]
const EVALUATION_STEPS = 36

function useEvaluationPlayback() {
  const [step, setStep] = useState(EVALUATION_STEPS)
  const diagramRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stop = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
  }, [])
  const replay = useCallback(() => {
    stop()
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStep(EVALUATION_STEPS)
      return
    }
    let next = 0
    setStep(0)
    timerRef.current = setInterval(() => {
      next += 1
      setStep(next)
      if (next >= EVALUATION_STEPS) stop()
    }, 80)
  }, [stop])
  useEffect(() => {
    const diagram = diagramRef.current
    if (!diagram) return
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)")
    const finish = () => {
      stop()
      setStep(EVALUATION_STEPS)
    }
    const motionChanged = () => {
      if (motion.matches) finish()
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          replay()
          observer.disconnect()
        }
      },
      { threshold: 0.3 }
    )
    observer.observe(diagram)
    motion.addEventListener("change", motionChanged)
    return () => {
      observer.disconnect()
      motion.removeEventListener("change", motionChanged)
      stop()
    }
  }, [replay, stop])
  return { step, diagramRef, replay, running: step < EVALUATION_STEPS }
}

function EvaluateDemo() {
  const { step, diagramRef, replay, running } = useEvaluationPlayback()
  const baselineChecked = Math.min(step, 24)
  const candidateChecked = Math.max(0, Math.min(step - 12, 24))
  const [caseId, setCaseId] = useState("returns")
  const example = evaluationCases.find((item) => item.id === caseId)!
  return (
    <div>
      <div className={styles.demoControls}>
        <span>Change the prompt. Keep the test cases.</span>
        <div className={styles.comparisonControls}>
          <span className={styles.sampleTag}>SUPPORT QA / 24 CASES</span>
          <Button
            size="sm"
            variant="ghost-muted"
            onClick={replay}
            disabled={running}
            aria-label="Replay evaluation comparison"
          >
            <RotateCcw aria-hidden="true" />
            Replay
          </Button>
        </div>
      </div>
      <div
        ref={diagramRef}
        className={`${styles.canvas} ${styles.evaluateCanvas}`}
        data-running={running}
      >
        <div className={styles.canvasTop}>
          <span>01 / COMPARE ON THE SAME EVIDENCE</span>
          <span>BASELINE → CANDIDATE</span>
        </div>
        <div className={styles.evaluationFlow}>
          <div className={styles.datasetNode}>
            <Database size={40} strokeWidth={1.3} />
            <strong>
              Same 24 <br />
              questions.
            </strong>
            <p>
              Real examples. <br />
              Expected answers. <br />
              One frozen dataset.
            </p>
          </div>
          <Connector split />
          <div className={styles.runGrid}>
            <div className={styles.run}>
              <Label>Original prompt</Label>
              <div className={styles.runScore}>
                {Math.min(baselineChecked, 18)}
                <span>/ 24 pass</span>
              </div>
              <CaseGrid pass={18} processed={baselineChecked} />
            </div>
            <div className={`${styles.run} ${styles.candidate}`}>
              <Label>Updated prompt</Label>
              <div className={styles.runScore}>
                {Math.min(candidateChecked, 23)}
                <span>/ 24 pass</span>
              </div>
              <CaseGrid pass={23} processed={candidateChecked} />
            </div>
          </div>
        </div>
        <div className={styles.canvasBottom}>
          <strong role="status">
            {running ? (
              "Checking the same 24 cases…"
            ) : (
              <>
                5 improved <span> / </span> 0 regressed <span> / </span> 1 still
                needs work
              </>
            )}
          </strong>
          <span>EVERY SQUARE IS A CASE</span>
        </div>
      </div>
      <Tabs
        value={caseId}
        onValueChange={setCaseId}
        className={styles.caseInspector}
      >
        <div className={styles.demoControls}>
          <span>Look beyond the score.</span>
          <TabsList aria-label="Evaluation case">
            {evaluationCases.map((item) => (
              <TabsTrigger key={item.id} value={item.id}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value={caseId} className={styles.caseDetail}>
          <div className={styles.caseQuestion}>
            <Label>Test question</Label>
            <p>{example.input}</p>
            <span
              className={styles.caseVerdict}
              data-improved={example.improved}
            >
              {example.improved ? <Check size={15} /> : <X size={15} />}
              {example.improved ? "Improved" : "Still failing"}
            </span>
          </div>
          <div>
            <Label>Before</Label>
            <p>{example.before}</p>
          </div>
          <div>
            <Label>After</Label>
            <p>{example.after}</p>
            {!example.improved && (
              <small>
                The source does not cover custom items. A citation alone does
                not make an answer correct.
              </small>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

const metrics = {
  latency: {
    label: "Latency",
    value: "3.8s",
    unit: "P95 LATENCY",
    line: "M0 110L45 106L90 112L135 94L180 100L225 90L270 96L315 45L360 52L405 18L450 25",
    insight: "The slowdown starts with retrieval.",
    details:
      "The requests in this window spend most of their time waiting for the search tool.",
    rows: [
      ["search.documents", "2.4s"],
      ["generate.answer", "1.1s"],
      ["verify.sources", "0.3s"],
    ],
  },
  cost: {
    label: "Cost",
    value: "$0.06",
    unit: "AVG. ESTIMATED COST / REQUEST",
    line: "M0 120L45 122L90 100L135 110L180 90L225 92L270 60L315 62L360 40L405 45L450 20",
    insight: "Longer prompts are driving the increase.",
    details:
      "Inspect the model calls in this window and compare their recorded token usage.",
    rows: [
      ["Input tokens", "8,200"],
      ["Output tokens", "640"],
      ["Model calls", "2"],
    ],
  },
  quality: {
    label: "Quality",
    value: "86%",
    unit: "EVALUATION PASS RATE",
    line: "M0 20L45 24L90 18L135 28L180 32L225 30L270 65L315 60L360 90L405 88L450 100",
    insight: "Return-policy cases need a closer look.",
    details:
      "Open the failed evaluation cases and compare their answers against the expected behavior.",
    rows: [
      ["Return policy", "6 failed"],
      ["Account access", "1 failed"],
      ["Shipping", "0 failed"],
    ],
  },
}
function DiscoverDemo() {
  const [metric, setMetric] = useState<keyof typeof metrics>("latency")
  const current = metrics[metric]
  return (
    <Tabs
      value={metric}
      onValueChange={(value) => setMetric(value as keyof typeof metrics)}
    >
      <div className={styles.demoControls}>
        <span>Find the signal. Follow the evidence.</span>
        <TabsList aria-label="Dashboard metric">
          {Object.entries(metrics).map(([key, item]) => (
            <TabsTrigger key={key} value={key}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent value={metric}>
        <AnimatedDiagram
          key={metric}
          className={`${styles.canvas} ${styles.discoverCanvas}`}
        >
          <div className={styles.canvasTop}>
            <span>01 / FROM A NUMBER TO A NEXT STEP</span>
            <span>LAST 7 DAYS</span>
          </div>
          <div className={styles.discoveryGrid}>
            <div className={styles.metricChart}>
              <Label>{current.unit}</Label>
              <strong className={styles.bigMetric}>{current.value}</strong>
              <svg
                viewBox="0 0 450 150"
                role="img"
                aria-label={`${current.label} trend over seven days`}
              >
                <path
                  className={styles.gridLines}
                  d="M0 25H450M0 75H450M0 125H450"
                />
                <path
                  pathLength={1}
                  className={styles.plotLine}
                  d={current.line}
                />
                <circle
                  cx="450"
                  cy={metric === "quality" ? 100 : metric === "cost" ? 20 : 25}
                  r="5"
                />
              </svg>
              <div className={styles.chartAxis}>
                <span>MON</span>
                <span>WED</span>
                <span>FRI</span>
                <span>SUN</span>
              </div>
            </div>
            <div className={styles.discoveryDetail}>
              <ArrowDown size={26} />
              <h3>{current.insight}</h3>
              <p>{current.details}</p>
              <div className={styles.metricRows}>
                {current.rows.map(([name, value]) => (
                  <div key={name}>
                    <span>{name}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className={styles.canvasBottom}>
            <span>
              A chart tells you where to look. The underlying records tell you
              why.
            </span>
            <span>EXPLORE A METRIC ↑</span>
          </div>
        </AnimatedDiagram>
      </TabsContent>
    </Tabs>
  )
}

export function ProductPreview({ pillar }: { pillar: ProductPillar }) {
  return (
    <figure className={styles.demo}>
      {pillar.slug === "build" ? (
        <BuildDemo />
      ) : pillar.slug === "observe" ? (
        <ObserveDemo />
      ) : pillar.slug === "evaluate" ? (
        <EvaluateDemo />
      ) : (
        <DiscoverDemo />
      )}
      <figcaption>
        Interactive explanation · illustrative data, not a live application run
      </figcaption>
    </figure>
  )
}

const promptCode = `import { createDatool } from "@datool/sdk"

const datool = createDatool()
const prompt = await datool.prompts.get(
  "support-answer", { version: 2 }
)

const messages = prompt.render({
  question: "Can I return this after 45 days?",
  policy: "Returns accepted within 30 days."
})`
const scorerCode = `function evaluate({ trace }) {
  const hasCitation =
    trace.output?.citations?.length > 0

  return {
    score: hasCitation ? 1 : 0,
    passed: hasCitation,
    reason: hasCitation
      ? "Source included"
      : "Missing source"
  }
}`
function CodePanel({
  name,
  code,
  note,
  bare = false,
}: {
  name: string
  code: string
  note?: string
  bare?: boolean
}) {
  return (
    <div className={styles.codePanel}>
      {!bare && (
        <div className={styles.codeHeader}>
          <Terminal size={16} />
          <span>{name}</span>
          <span>JAVASCRIPT</span>
        </div>
      )}
      <CodeEditor
        value={code}
        onChange={() => undefined}
        language="javascript"
        label={`${name} example (read only)`}
        readOnly
        autoSize
        lineNumbers={false}
        variant="embedded"
        className={styles.exampleEditor}
      />
      {note && <p>{note}</p>}
    </div>
  )
}

function ScorerDemo() {
  const [scorer, setScorer] = useState("llm")

  return (
    <Tabs value={scorer} onValueChange={setScorer}>
      <TabsList aria-label="Scorer example" className="mb-3">
        <TabsTrigger value="javascript">
          <ScorerTypeBadge type="javascript" variant="label" active />
        </TabsTrigger>
        <TabsTrigger value="llm">
          <ScorerTypeBadge type="llm" variant="label" active />
        </TabsTrigger>
      </TabsList>
      <div className={styles.scorerPanels}>
        <TabsContent
          value="javascript"
          forceMount
          inert={scorer !== "javascript"}
          aria-hidden={scorer !== "javascript"}
        >
          <CodePanel name="citation-check.js" code={scorerCode} bare />
        </TabsContent>
        <TabsContent
          value="llm"
          forceMount
          inert={scorer !== "llm"}
          aria-hidden={scorer !== "llm"}
        >
          <div className="overflow-hidden rounded-md border border-border bg-background">
            <FormRow label="Model">
              <div className="flex items-center gap-2 text-sm">
                <ModelProviderLogo provider="datool" />
                <span>Datool Scorer Model</span>
              </div>
            </FormRow>
            <InspectorSection
              label="Rubric"
              variant="form"
              summaryClassName="pl-4"
            >
              <CodeEditor
                label="LLM scorer rubric example (read only)"
                language="mustache"
                lineNumbers={false}
                autoSize
                readOnly
                variant="embedded"
                value={`Question: {{input}}
Answer: {{output}}
Reference: {{expected}}

Pass: every claim is supported by the reference.
Fail: any claim contradicts the reference.

Choose Pass or Fail and explain why.`}
                onChange={() => undefined}
              />
            </InspectorSection>
            <InspectorSection
              label="Choice scores"
              variant="form"
              summaryClassName="pl-4"
            >
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted px-3 py-2">
                  <dt>Pass</dt>
                  <dd className="font-mono">1</dd>
                </div>
                <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted px-3 py-2">
                  <dt>Fail</dt>
                  <dd className="font-mono">0</dd>
                </div>
              </dl>
            </InspectorSection>
          </div>
        </TabsContent>
      </div>
    </Tabs>
  )
}

export function FeatureVisual({ feature }: { feature: string }) {
  if (feature === "integrations")
    return (
      <CodePanel
        name="app.ts"
        code={promptCode}
        note="Fetch a published prompt version, then render it with your application's variables."
      />
    )
  if (feature === "scorers") return <ScorerDemo />
  if (feature === "datasets")
    return (
      <div className={`${styles.lessonPanel} ${styles.paper}`}>
        <Label>A production mistake becomes a test</Label>
        <div className={styles.caseField}>
          <Label>Input</Label>
          <p>{question}</p>
        </div>
        <div className={styles.caseField}>
          <Label>Expected behavior</Label>
          <p>
            Explain that the 30-day return window has passed. Cite the returns
            policy.
          </p>
        </div>
        <div className={styles.caseField}>
          <Label>Output diff</Label>
          <dl className={styles.outputDiff}>
            <div>
              <dt>Expected output</dt>
              <dd>
                The return window is{" "}
                <mark className={styles.expectedChange}>30 days</mark>, so an
                order delivered 45 days ago is{" "}
                <mark className={styles.expectedChange}>
                  outside the policy. [1]
                </mark>
              </dd>
            </div>
            <div>
              <dt>Actual output</dt>
              <dd>
                The return window is{" "}
                <mark className={styles.actualChange}>60 days</mark>, so an
                order delivered 45 days ago is{" "}
                <mark className={styles.actualChange}>within the policy.</mark>
              </dd>
            </div>
          </dl>
        </div>
      </div>
    )
  if (feature === "reviews")
    return (
      <div className={`${styles.lessonPanel} ${styles.lilac}`}>
        <Label>A shared rubric, not a gut feeling</Label>
        <blockquote>
          “The answer is accurate, but it could explain the customer’s next
          option.”
        </blockquote>
        <div className={styles.rubricRow}>
          <span>Correctness</span>
          <strong>
            <Check size={16} /> Correct
          </strong>
        </div>
        <div className={styles.rubricRow}>
          <span>Helpfulness</span>
          <div className={styles.rating}>
            {[1, 2, 3, 4, 5].map((n) => (
              <span key={n} data-selected={n === 3}>
                {n}
              </span>
            ))}
          </div>
        </div>
        <div className={styles.rubricRow}>
          <span>Reviewed by</span>
          <strong>
            <span className={styles.avatar}>JL</span> Jamie Lee
          </strong>
        </div>
        <div className={styles.lessonFoot}>
          Keep the judgment beside the original evidence.
        </div>
      </div>
    )
  if (feature === "prompts")
    return (
      <AnimatedDiagram className={`${styles.lessonPanel} ${styles.leaf}`}>
        <Label>Change the draft. Keep a stable version.</Label>
        <div className={styles.versionDiagram}>
          <div className={styles.versionSource}>
            <strong>v1</strong>
            <span>Published</span>
          </div>
          <svg
            viewBox="0 0 160 176"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path pathLength={1} d="M0 36H160M35 36C70 36 70 140 110 140H160" />
            <circle cx="35" cy="36" r="5" />
          </svg>
          <div className={styles.versionDestination}>
            <strong>v2</strong>
            <span>Tested & published</span>
          </div>
          <div className={styles.versionDestination}>
            <strong className={styles.draftVersion}>Draft</strong>
            <span>Work in progress</span>
          </div>
        </div>
        <div className={styles.promptDiff}>
          <span>+ Use only the supplied policy.</span>
          <span>+ Cite the source in your answer.</span>
        </div>
        <div className={styles.lessonFoot}>
          Your application can keep using v1 while you work.
        </div>
      </AnimatedDiagram>
    )
  if (feature === "playground")
    return (
      <div className={styles.codePanel}>
        <div className={styles.codeHeader}>
          <Terminal size={16} />
          <span>Terminal</span>
          <span>CLI</span>
        </div>
        <div className={styles.terminalBody}>
          <p>Connect your local app. Reload on save.</p>
          <pre>
            <span aria-hidden="true">$ </span>
            <code>npx datool connect ./handler.ts --watch</code>
          </pre>
        </div>
        <p>
          Keep this terminal running, then select your app in Playground to try
          an input and inspect its trace.
        </p>
      </div>
    )
  if (feature === "traces")
    return <ProductTraceExample compact navigation="timeline" />
  if (feature === "agents")
    return (
      <div className={`${styles.lessonPanel} ${styles.leaf}`}>
        <Label>Keep the relationships in view</Label>
        <div className={styles.flowRoot}>
          <GitBranch size={22} />
          <strong>customer.support</strong>
          <span>workflow</span>
        </div>
        <svg
          className={styles.branchDiagram}
          viewBox="0 0 400 80"
          aria-hidden="true"
        >
          <path d="M200 0V20Q200 35 185 35H85Q70 35 70 50V80M200 20Q200 35 215 35H315Q330 35 330 50V80" />
        </svg>
        <div className={styles.agentPair}>
          <div>
            <Bot size={30} />
            <strong>triage.agent</strong>
            <span>Classify the request</span>
          </div>
          <div>
            <Bot size={30} />
            <strong>support.agent</strong>
            <span>Retrieve → answer</span>
          </div>
        </div>
        <div className={styles.lessonFoot}>
          Group by agent or workflow. Investigate the individual run.
        </div>
      </div>
    )
  if (feature === "sessions")
    return (
      <div className={`${styles.lessonPanel} ${styles.lilac}`}>
        <Label>Session / customer-842</Label>
        <div className={styles.sessionMessage}>
          <span>01</span>
          <p>
            “Where is my order?”<small>Order lookup → delivery status</small>
          </p>
        </div>
        <div className={styles.sessionMessage}>
          <span>02</span>
          <p>
            “It arrived damaged.”<small>Same customer → new context</small>
          </p>
        </div>
        <div className={styles.sessionMessage}>
          <span>03</span>
          <p>
            “Can I return it?”<small>Return policy → next action</small>
          </p>
        </div>
        <div className={styles.lessonFoot}>
          Three requests. One conversation to understand.
        </div>
      </div>
    )
  if (feature === "dashboards") return <ProductDashboardExample />
  return (
    <AnimatedDiagram className={`${styles.lessonPanel} ${styles.leaf}`}>
      <Label>A rule with a clear reason to act</Label>
      <div className={styles.alertRule}>
        <span>WHEN</span>
        <strong>10 failed requests</strong>
        <span>IN A</span>
        <strong>5-minute window</strong>
      </div>
      <svg className={styles.alertPath} viewBox="0 0 400 65" aria-hidden="true">
        <path pathLength={1} d="M200 0V55m-8-8 8 8 8-8" />
      </svg>
      <div className={styles.slackNotification}>
        <div className={styles.slackChannel}>
          <Slack size={18} aria-hidden="true" />
          <strong># ai-alerts</strong>
          <span>Slack</span>
        </div>
        <div className={styles.slackMessage}>
          <span className={styles.slackAvatar}>D</span>
          <div>
            <div className={styles.slackSender}>
              <strong>Datool</strong>
              <span>APP</span>
              <small>Just now</small>
            </div>
            <strong>Support workflow needs attention</strong>
            <p>10 failed requests in the last 5 minutes.</p>
            <span className={styles.slackTraceLink}>
              View matching traces →
            </span>
          </div>
        </div>
      </div>
      <div className={styles.lessonFoot}>
        Route your webhook to a Slack workflow. Cooldowns limit repeat alerts.
      </div>
    </AnimatedDiagram>
  )
}
