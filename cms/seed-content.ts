import type { Faq, Page } from "@/payload-types"

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
      "Datool helps teams inspect AI traces, build evaluation datasets, and measure quality with scorers. Follow a request from input to output and see where it needs work.",
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
export function landingBlocks(faqIds: number[]): Page["layout"] {
  return [
    {
      blockType: "hero",
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
      content: richText(
        "Start with the evidence you already have. Trace a workflow, review an unexpected result, and keep that example as a test for the next change."
      ),
    },
    {
      blockType: "faq",
      title: "A few things you might be wondering.",
      items: faqIds,
    },
    {
      blockType: "callToAction",
      title: "Your next improvement starts with a trace.",
      description: "Connect your application and take a closer look.",
      label: "Open Datool",
      href: "/sign-in",
    },
  ]
}
