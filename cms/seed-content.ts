import type { Faq, Page } from "@/payload-types"
import { demoHref } from "@/lib/marketing/demo"

export function richText(text: string): Faq["answer"] {
  return {
    root: {
      type: "root",
      format: "",
      indent: 0,
      version: 1,
      direction: null,
      children: [
        {
          type: "paragraph",
          version: 1,
          format: "",
          indent: 0,
          direction: null,
          children: [
            {
              type: "text",
              version: 1,
              text,
              format: 0,
              detail: 0,
              mode: "normal",
              style: "",
            },
          ],
        },
      ],
    },
  }
}
export const faqContent = [
  {
    slug: "what-is-datool",
    question: "What is Datool?",
    answer:
      "Datool is one platform to build AI agents and see what they do. Launch agents that sell, support and guide customers on WhatsApp, your website or inside your product, then trace, evaluate and improve every conversation.",
  },
  {
    slug: "where-can-agents-talk",
    question: "Where can Datool agents talk to my customers?",
    answer:
      "On WhatsApp, in a chat widget on your website and inside your product. Your team works the same conversations from one inbox and can take over whenever a person should answer.",
  },
  {
    slug: "how-do-agents-know-my-business",
    question: "How does an agent know my products and policies?",
    answer:
      "Add your catalog, help articles and policies as knowledge, and give the agent actions such as checking an order or opening a ticket. Guardrails and tests keep its answers on track before and after launch.",
  },
  {
    slug: "can-i-observe-my-own-agent",
    question: "Can I use Datool with an AI app I built myself?",
    answer:
      "Yes. Connect any AI application with the Datool SDK or OpenTelemetry to trace its requests, evaluate real examples and measure quality. You don't need to build your agents in Datool.",
  },
  {
    slug: "what-can-i-evaluate",
    question: "What can I evaluate?",
    answer:
      "Use recorded traces or dataset cases to evaluate your AI workflows. Combine code-based and LLM scorers with human reviews, then compare results across evaluation runs.",
  },
  {
    slug: "how-do-i-start",
    question: "How do I get started?",
    answer:
      "Sign in with your approved Google account, select a workspace and project, and follow the project setup instructions to connect your application.",
  },
  {
    slug: "how-do-i-connect-my-app",
    question: "How does Datool connect to my application?",
    answer:
      "Use the Datool SDK to record workflows, model calls, and tool calls, or add Datool's span processor to your existing OpenTelemetry setup. You can also connect an application for dataset evaluations without the tracing SDK. Instrumenting the steps inside it gives you the detailed trace.",
  },
  {
    slug: "what-can-i-see-in-a-trace",
    question: "What can I see inside a trace?",
    answer:
      "Follow a request through its recorded steps, with inputs, outputs, timing, errors, and scores in context. For instrumented model calls, Datool also shows reported token usage and cost estimates when usage and pricing information are available. Related traces can be grouped into sessions.",
  },
  {
    slug: "can-i-turn-traces-into-test-cases",
    question: "Can I turn a real failure into a test case?",
    answer:
      "Yes. Save useful examples from recorded traces into a dataset, add reference answers where needed, and use those cases in evaluation runs. That unexpected answer becomes a repeatable check for the next version of your workflow.",
  },
  {
    slug: "how-do-i-measure-answer-quality",
    question: "How do I decide what a good answer looks like?",
    answer:
      "Choose a built-in evaluator, write a JavaScript or Python scorer for a precise rule, or use an LLM scorer with your own rubric. Test the scorer on representative examples before running it across a dataset. Human reviews can add ratings and comments alongside automated judgments.",
  },
  {
    slug: "can-i-compare-prompts-and-models",
    question: "Can I compare different prompts or models?",
    answer:
      "Yes. Run the same cases against different application versions or prompt and model settings supported by your app. Compare scores and individual outputs to see which cases improved or regressed. You can also re-score saved outputs with a different scorer without calling the application again.",
  },
  {
    slug: "can-my-team-review-answers",
    question: "Can my team review answers manually?",
    answer:
      "Yes. Create a review session from selected traces, define the ratings that matter to your team, and inspect each answer in context. Reviewers can save scores, leave comments, and annotate specific parts of the input or output. Those judgments complement your automated evaluations.",
  },
]
// The home page sells the whole platform; the Observe page keeps the original
// trace-first story.
export const homeFaqSlugs = [
  "what-is-datool",
  "where-can-agents-talk",
  "how-do-agents-know-my-business",
  "can-i-observe-my-own-agent",
  "how-do-i-start",
]
export const observeFaqSlugs = [
  "how-do-i-connect-my-app",
  "what-can-i-see-in-a-trace",
  "can-i-turn-traces-into-test-cases",
  "what-can-i-evaluate",
  "how-do-i-measure-answer-quality",
  "can-i-compare-prompts-and-models",
  "can-my-team-review-answers",
]

export const landingMeta = {
  title: "AI agents you can see inside",
  seo: {
    description:
      "Build AI agents for WhatsApp, your website and your product, and trace, evaluate and improve every conversation with Datool.",
  },
}

export function landingBlocks(faqIds: number[]): Page["layout"] {
  return [
    {
      blockType: "hero",
      eyebrow: "AI agents & observability",
      title: "Build AI agents. See every decision they make.",
      description:
        "Observe the agents and workflows you already run, or launch new ones on WhatsApp, your website and your app.",
      actions: [
        { label: "Get started", href: "/sign-up" },
        { label: "Request a demo", href: demoHref },
      ],
    },
    {
      blockType: "features",
      blockName: "platform",
      title:
        "Bring your agents or build new ones. See all of them in one place.",
      items: [
        {
          title: "Observe the agents you already run",
          description:
            "Add the Datool SDK or OpenTelemetry to your app. Every request, model call and tool call becomes a trace.",
          href: "/docs/get-started/first-trace",
        },
        {
          title: "Launch new agents",
          description:
            "Give an agent your catalog, policies and tools. Put it on WhatsApp, your website or inside your app, and take over any conversation.",
          href: "#agents",
        },
        {
          title: "Improve every one of them",
          description:
            "Built in Datool or in your code, every agent gets the same traces, scores, reviews and dashboards. Keep failures as tests and ship the next version with evidence.",
          href: "/product/observe",
        },
      ],
    },
    {
      blockType: "features",
      blockName: "agents",
      title: "Agents that work where your customers already are.",
      items: [
        {
          title: "Sales on WhatsApp",
          description: "Recommends products and closes sales in the chat.",
          href: "/agents/whatsapp-sales",
        },
        {
          title: "Sales on your website",
          description: "A chat widget that helps visitors find and buy.",
          href: "/agents/website-sales",
        },
        {
          title: "Support on WhatsApp",
          description: "Answers from your policies and checks your systems.",
          href: "/agents/whatsapp-support",
        },
        {
          title: "Support on your website",
          description: "A help widget that troubleshoots and hands off.",
          href: "/agents/website-support",
        },
        {
          title: "Product guide",
          description: "Onboards and guides users inside your app.",
          href: "/agents/product-guidance",
        },
      ],
    },
    {
      blockType: "features",
      blockName: "loop",
      title: "Launch it. Watch it. Make it better.",
      items: [
        {
          title: "Launch",
          description:
            "Start from a proven agent, connect your store or app and go live on the channels your customers use.",
        },
        {
          title: "Watch",
          description:
            "Every conversation becomes a trace: the messages, the knowledge it used, the tools it called and what it cost.",
        },
        {
          title: "Improve",
          description:
            "Score answers, review the hard cases and keep failures as tests, so each change makes the agent better.",
        },
      ],
    },
    ...(faqIds.length
      ? [
          {
            blockType: "faq" as const,
            title: "Questions teams ask before they start.",
            items: faqIds,
          },
        ]
      : []),
    {
      blockType: "callToAction",
      title: "Put an agent to work. Keep an eye on every answer.",
      description:
        "Talk to us on WhatsApp and see an agent run on your own catalog.",
      label: "Request a demo",
      href: demoHref,
    },
  ]
}

// The original home page story, now the top of the Observe page. Blocks named
// "story" render in the landing style above the Observe chapters.
export function observeStoryBlocks(): Page["layout"] {
  return [
    {
      blockType: "hero",
      blockName: "story",
      eyebrow: "Observability & evaluation for AI",
      title: "See what your AI is doing. Make it better.",
      description:
        "Follow every trace, find what went wrong, and turn real examples into evaluations. One place to understand and improve your AI workflows.",
      actions: [
        { label: "Open Datool", href: "/sign-in" },
        { label: "How it works", href: "/pages/how-it-works" },
      ],
    },
    {
      blockType: "features",
      blockName: "story",
      title: "From a single request to a clearer picture.",
      items: [
        {
          title: "Follow every trace",
          description:
            "Inspect inputs, outputs, spans, latency, and scores in the context of the whole workflow.",
        },
        {
          title: "Evaluate real examples",
          description:
            "Build datasets from the cases that matter. Test changes with repeatable evaluation runs.",
        },
        {
          title: "Make quality visible",
          description:
            "Use scorers, human reviews, and dashboards to understand how your application performs.",
        },
      ],
    },
    {
      blockType: "richContent",
      blockName: "story",
      content: richText(
        "Start with the evidence you already have. Trace a workflow, review an unexpected result, and keep that example as a test for the next change."
      ),
    },
  ]
}
