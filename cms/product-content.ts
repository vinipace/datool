import type { Page } from "../payload-types"
import {
  productFeatures,
  productPillars,
  type ProductPillar,
  productPageSlug,
  type ProductFeature,
} from "../lib/marketing/product"
import { richText } from "./seed-content"

type FeatureCopy = {
  title: string
  description: string
  capabilities: [string, string][]
  example: string
}

// Starter copy grounded in content/docs and docs/alerts.md. Once seeded, editors
// own these pages; rerunning the seed never overwrites their changes or drafts.
const copy: Record<ProductFeature["slug"], FeatureCopy> = {
  traces: {
    title: "Find the step. See the evidence.",
    description:
      "An answer alone cannot explain a failure. Open its trace to see the recorded inputs, outputs, and timing for each model call and tool.",
    capabilities: [
      [
        "Follow the execution",
        "Move through the span tree and timeline to understand which steps ran and how they relate.",
      ],
      [
        "Find the useful signal",
        "Filter requests by status, timing, metadata, and scores. Save the views you return to.",
      ],
      [
        "Keep the evidence",
        "Inspect the captured output, then send a useful example to a dataset or a human review.",
      ],
    ],
    example:
      "A support answer looks wrong. Open its trace, inspect the retrieval step, and see exactly which context reached the model. Keep that request as a test case for the next change.",
  },
  agents: {
    title: "One workflow. Many decisions.",
    description:
      "Follow the relationships between workflows, agents, and the tools they call. Group related runs to see whether a problem is isolated or keeps coming back.",
    capabilities: [
      [
        "Group related runs",
        "Named agent groups connect invocations across traces, keeping the agent’s identity separate from individual span kinds.",
      ],
      [
        "Compare performance",
        "Explore operation counts, latency, errors, and recorded cost across agent names and versions.",
      ],
      [
        "Inspect the decisions",
        "Open the underlying traces to understand the inputs, outputs, and tools behind a result.",
      ],
    ],
    example:
      "Your research agent starts taking longer. Find the agent in the collection, narrow the time range, and open a slow trace to see which model or tool step added the delay.",
  },
  workflows: {
    title: "A clear view of every moving part.",
    description:
      "Track a workflow from its first input to its final output. Group repeated executions and inspect the steps that make a result reliable—or cause it to fail.",
    capabilities: [
      [
        "Give each workflow an identity",
        "Record a workflow name and version so related operations stay together across requests.",
      ],
      [
        "Understand the pattern",
        "See volume, timing, errors, and recorded cost for the executions matching your filters.",
      ],
      [
        "Go straight to the cause",
        "Follow a workflow into its traces and inspect the individual retrieval, model, and tool spans.",
      ],
    ],
    example:
      "A document-processing workflow fails on a new file format. Move from the workflow overview into the failed request, find the failing step, and preserve its input for an evaluation.",
  },
  sessions: {
    title: "Keep the conversation in the picture.",
    description:
      "“Can I return it?” means little without what came before. Group related requests into a session to understand the full interaction.",
    capabilities: [
      [
        "Connect the requests",
        "Attach a shared session ID to requests that belong to the same interaction.",
      ],
      [
        "Keep the sequence",
        "Explore the related traces to see how inputs and responses developed over the interaction.",
      ],
      [
        "Inspect any step",
        "Open a request’s trace without losing its relationship to the wider session.",
      ],
    ],
    example:
      "An assistant handles the first question correctly but misunderstands a follow-up. Open the session to compare the requests, then inspect the trace where the conversation changed direction.",
  },
  playground: {
    title: "Ask a real question. See the whole result.",
    description:
      "Connect your application and give it an input. The Playground keeps the output and its trace together, so you can inspect what happened and try again.",
    capabilities: [
      [
        "Connect your application",
        "Expose your app through the CLI bridge with a workflow input object or agent messages.",
      ],
      [
        "Try a focused change",
        "Run new inputs against the connected app, with input schemas guiding the form where available.",
      ],
      [
        "Keep each experiment",
        "Playground invocations create saved evaluation runs, including failed calls and calls without scorers.",
      ],
    ],
    example:
      "You have a question your assistant struggled with. Send it through the Playground, inspect the returned output and captured trace, then use the saved run as evidence for your next experiment.",
  },
  prompts: {
    title: "Try a new instruction. Keep a version you trust.",
    description:
      "A prompt change can improve one answer and break another. Work on a draft, test the result, and publish a version your application can name.",
    capabilities: [
      [
        "Work in drafts",
        "Edit messages, models, and variables without changing the published prompt your application uses.",
      ],
      [
        "Publish a stable version",
        "Each publication creates an immutable numbered version. Pin a version when reproducibility matters.",
      ],
      [
        "Evaluate before adopting",
        "Use prompt overrides in evaluations and keep the prompt version attached to the resulting evidence.",
      ],
    ],
    example:
      "A shorter system prompt might improve your assistant’s responses. Preview it with variables, evaluate the draft against saved cases, and publish a new version when you are ready.",
  },
  integrations: {
    title: "A few lines. Your existing application.",
    description:
      "Keep your models, tools, and application code. Fetch managed prompts with the SDK, connect your app through the CLI, or work with Datool from an MCP client.",
    capabilities: [
      [
        "Instrument with the SDK",
        "Capture application inputs, outputs, spans, and model activity in your project.",
      ],
      [
        "Work from the terminal",
        "Use the CLI to connect applications, inspect recorded evidence, and run evaluation workflows.",
      ],
      [
        "Connect AI tools with MCP",
        "Let supported clients investigate traces and work with Datool resources through scoped access.",
      ],
    ],
    example:
      "Instrument a workflow in your application, inspect a failed trace from the terminal, and use an MCP-connected assistant to help investigate the same evidence. Start with the SDK, CLI, and MCP reference guides.",
  },
  datasets: {
    title: "Keep the mistakes you never want to repeat.",
    description:
      "Turn a useful trace into a test case. Save the input, relevant context, and expected behavior in a dataset you can run against future changes.",
    capabilities: [
      [
        "Start from real evidence",
        "Promote a production trace or span into a case with provenance, or create and import cases directly.",
      ],
      [
        "Define the expectation",
        "Keep the observed output separate from the expected answer. Add metadata that explains why the case matters.",
      ],
      [
        "Freeze the comparison",
        "Use immutable dataset snapshots so evaluation runs stay reproducible as your working dataset evolves.",
      ],
    ],
    example:
      "A retrieval answer cites the wrong document. Save its input, write the expected behavior, and add it to your support dataset. The next retrieval change can be tested against this exact case.",
  },
  scorers: {
    title: "Tell the test what “good” means.",
    description:
      "Check an exact value with code, ask an LLM judge to apply a rubric, or combine several checks. Each result keeps the score and its reason.",
    capabilities: [
      [
        "Choose the right check",
        "Use JavaScript, Python, LLM, or library scorers for the quality question you need to answer.",
      ],
      [
        "Test the scorer itself",
        "Preview a rule against known good and bad examples. An execution error remains an error, not a zero score.",
      ],
      [
        "Keep versions reproducible",
        "Saved scorer versions make it possible to understand which rule produced an evaluation result.",
      ],
    ],
    example:
      "You want answers grounded in retrieved context. Test a groundedness scorer on supported and unsupported answers, then use its saved version across the cases in an evaluation.",
  },
  evaluations: {
    title: "Know what your next change changes.",
    description:
      "Run the same cases against a new version, or re-score recorded outputs with a different rule. Compare the results with the evidence that produced them.",
    capabilities: [
      [
        "Run your connected app",
        "Invoke a connected application over dataset cases and capture its outputs and traces.",
      ],
      [
        "Re-score saved evidence",
        "Apply scorers to frozen outputs when you want to change the measurement without invoking the app again.",
      ],
      [
        "Compare case by case",
        "Inspect improvements, regressions, execution errors, and the underlying score results across runs.",
      ],
    ],
    example:
      "A new prompt improves most answers but breaks one important case. Compare the runs, open that case’s evidence, and decide whether to revise the prompt before adopting it.",
  },
  reviews: {
    title: "Some answers need a human eye.",
    description:
      "An answer can pass a code check and still be unhelpful. Give reviewers the original evidence and shared criteria to judge correctness, tone, and usefulness.",
    capabilities: [
      [
        "Build a review queue",
        "Select useful traces and organize them into a session with instructions and assigned reviewers.",
      ],
      [
        "Review in context",
        "Read inputs, outputs, and spans in the inspector. Annotate the exact passages that need attention.",
      ],
      [
        "Keep the judgment",
        "Save ratings and notes with reviewer attribution. Required criteria determine when a review is complete.",
      ],
    ],
    example:
      "Automated scores miss whether a response feels helpful. Give reviewers a focused set of traces and clear criteria, then keep their notes alongside the model’s output.",
  },
  "human-scores": {
    title: "A shared language for human feedback.",
    description:
      "Define what reviewers should look for before they open the first trace. Reusable score collections keep a review consistent while allowing room for explanation.",
    capabilities: [
      [
        "Choose meaningful criteria",
        "Create numeric, category, multi-select, or text criteria that match the judgment you need.",
      ],
      [
        "Reuse a collection",
        "Group criteria into collections and attach them to review sessions.",
      ],
      [
        "Preserve the rubric",
        "Sessions snapshot their criteria so later definition changes do not silently change an earlier review’s meaning.",
      ],
    ],
    example:
      "Ask reviewers to rate helpfulness, select an error category, and explain their decision. Everyone uses the same rubric, and each saved result keeps the criteria it was judged against.",
  },
  dashboards: {
    title: "Start wide. Then ask a sharper question.",
    description:
      "Compare quality, latency, usage, and estimated cost across your recorded activity. Filter by workflow and time range, then inspect the records behind the metric.",
    capabilities: [
      [
        "Choose what matters",
        "Combine reusable widgets for request volume, latency, model usage, recorded cost, and evaluation results.",
      ],
      [
        "Keep the context",
        "Use date ranges and filters to narrow the view and share the same investigation context.",
      ],
      [
        "Go beyond the chart",
        "Follow a result into its traces to understand why a metric changed. Missing cost data stays distinct from zero.",
      ],
    ],
    example:
      "Latency rises while request volume stays steady. Narrow the dashboard’s date range, inspect the affected workflow, and open its traces to see which step slowed down.",
  },
  alerts: {
    title: "Set the signal that deserves your attention.",
    description:
      "Choose matching events or a count threshold over a time window. Get an in-app or webhook notification when the rule triggers, with a cooldown to limit repeats.",
    capabilities: [
      [
        "Define a useful trigger",
        "Start with a template or configure event filters and time-window count thresholds for your project.",
      ],
      [
        "Control the noise",
        "Use cooldowns to keep repeated matching activity from overwhelming your notifications.",
      ],
      [
        "Follow the delivery",
        "Inspect notification history and webhook delivery attempts when you need to understand what happened.",
      ],
    ],
    example:
      "A workflow begins failing repeatedly. A count-based alert brings the pattern to your attention, and you can investigate the matching traces to find the cause.",
  },
}

const pillarCopy: Record<
  ProductPillar["slug"],
  {
    title: string
    description: string
    workflowTitle: string
    workflow: [string, string][]
  }
> = {
  build: {
    title: "Make your next prompt work better.",
    description:
      "Try an idea against your actual application. See what changes, keep the useful versions, and take the result back into your code.",
    workflowTitle: "A shorter path from idea to evidence.",
    workflow: [
      [
        "Shape the instruction",
        "Draft a prompt, preview variables, and keep the published version stable while you experiment.",
      ],
      [
        "Run your application",
        "Connect your agent or workflow and try a real input in the Playground.",
      ],
      [
        "Keep what you learn",
        "Inspect the saved run, compare the output, and take useful cases into an evaluation.",
      ],
    ],
  },
  observe: {
    title: "Understand why your AI did that.",
    description:
      "A wrong answer is a starting point. Follow the request through tools, model calls, and context to find the step that needs to change.",
    workflowTitle: "From a surprising answer to the reason behind it.",
    workflow: [
      [
        "Find the request",
        "Filter by time, status, metadata, or scores. Save the views your team investigates often.",
      ],
      [
        "Follow the execution",
        "Read the span tree, timeline, and captured inputs and outputs to find the step that matters.",
      ],
      [
        "Make the evidence useful",
        "Turn the request into a dataset case or send it to reviewers with the original context attached.",
      ],
    ],
  },
  evaluate: {
    title: "A better answer. Or just a different one?",
    description:
      "Run your changes against the same real examples. See what improved, what broke, and which answers still need work before you ship.",
    workflowTitle: "A repeatable answer to “did it get better?”",
    workflow: [
      [
        "Collect the cases",
        "Start with real traces or import examples. Keep expected behavior separate from observed output.",
      ],
      [
        "Define good",
        "Choose code checks, LLM judges, or a human rubric that measures what matters to your application.",
      ],
      [
        "Compare the change",
        "Run the same cases against a candidate and inspect both improvements and regressions before adopting it.",
      ],
    ],
  },
  discover: {
    title: "Know where to look next.",
    description:
      "Find the patterns in your AI’s quality, speed, and cost. Move from a change in the numbers to the requests that explain it.",
    workflowTitle: "From a signal to a focused investigation.",
    workflow: [
      [
        "Ask a useful question",
        "Build a dashboard around the metrics, workflows, and time ranges your team needs to understand.",
      ],
      [
        "Notice what changes",
        "Compare patterns and set alert rules for matching events or count thresholds over time.",
      ],
      [
        "Follow the evidence",
        "Open the relevant traces, find the cause, and bring a concrete case into your next improvement.",
      ],
    ],
  },
}

// Four editable pillar pages. Feature slugs remain stable section anchors and
// compatibility redirects; the seed preserves existing editorial content.
export const productSeedPages: Pick<
  Page,
  "slug" | "title" | "layout" | "seo" | "_status"
>[] = productPillars.map((pillar) => {
  const content = pillarCopy[pillar.slug]
  const features = productFeatures.filter(
    (feature) =>
      feature.group === pillar.name ||
      (pillar.slug === "observe" && feature.slug === "dashboards")
  )
  return {
    slug: productPageSlug(pillar.slug),
    title: pillar.name,
    _status: "published",
    seo: { title: `${pillar.name} with Datool`, description: pillar.summary },
    layout: [
      {
        blockType: "hero",
        eyebrow: pillar.name,
        title: content.title,
        description: content.description,
        actions: [
          { label: "Start building", href: "/sign-up" },
          { label: "Read the docs", href: pillar.docs },
        ],
      },
      {
        blockType: "features",
        blockName: "workflow",
        title: content.workflowTitle,
        items: content.workflow.map(([title, description]) => ({
          title,
          description,
        })),
      },
      ...features.flatMap((feature): Page["layout"] => {
        const detail = copy[feature.slug]
        return [
          {
            blockType: "hero",
            blockName: feature.slug,
            eyebrow: feature.name,
            title: detail.title,
            description: detail.description,
            actions: [
              { label: `${feature.name} documentation`, href: feature.docs },
            ],
          },
          {
            blockType: "features",
            blockName: `${feature.slug}-capabilities`,
            title: `Inside ${feature.name.toLowerCase()}`,
            items: detail.capabilities.map(([title, description]) => ({
              title,
              description,
            })),
          },
          {
            blockType: "richContent",
            blockName: `${feature.slug}-example`,
            content: richText(detail.example),
          },
        ]
      }),
      {
        blockType: "callToAction",
        title: "Give your next change something to prove.",
        description:
          "Build, observe, evaluate, and discover in one workspace. Start with a single request and follow the evidence.",
        label: "Get started with Datool",
        href: "/sign-up",
      },
    ],
  }
})
