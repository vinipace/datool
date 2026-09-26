import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, userEvent, within } from "storybook/test"
import {
  evaluator,
  evalResult,
} from "../../.storybook/scenarios/datasets-evals/fixtures"
import { EvalScoreCell, ScoreExplanation } from "./eval-score-cell"

const meta = {
  title: "Tracer/Evals/EvalScoreCell",
  component: EvalScoreCell,
} satisfies Meta<typeof EvalScoreCell>

export default meta
type Story = StoryObj<typeof meta>

export const States: Story = {
  render: () => (
    <div className="grid gap-4 text-sm">
      <div className="flex items-center gap-5">
        <EvalScoreCell result={evalResult} />
        <EvalScoreCell
          result={{ ...evalResult, metadata: { skipped: true }, score: null }}
        />
        <EvalScoreCell
          result={{ ...evalResult, error: "Scorer timed out", status: "error" }}
        />
        <EvalScoreCell />
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getAllByRole("button", {
        name: "Explain Answer groundedness",
      })[0]
    )
    await expect(
      within(document.body).findByText("Pass threshold")
    ).resolves.toBeVisible()
  },
}

export const Explanation: Story = {
  render: () => <ScoreExplanation result={evalResult} />,
}

export const ScorerTypes: Story = {
  render: () => (
    <div className="grid gap-4 sm:grid-cols-3">
      {(["javascript", "llm", "python"] as const).map((type) => (
        <div key={type} className="rounded-lg border border-border bg-popover p-3">
          <ScoreExplanation
            result={{
              ...evalResult,
              definition: {
                ...evaluator.activeVersion,
                config: { ...evaluator.activeVersion.config!, type },
              },
            }}
          />
        </div>
      ))}
    </div>
  ),
}

export const LegacyScorer: Story = {
  args: {
    result: {
      ...evalResult,
      definition: { ...evaluator.activeVersion, config: undefined },
    },
  },
}

export const FailedWithoutReasoning: Story = {
  args: {
    result: {
      ...evalResult,
      evaluatorName: "Brand extraction: annotation fidelity",
      score: 0.5,
      passed: false,
      status: "failed",
      metadata: {},
      reasoning: null,
    },
  },
}

export const LongReasoning: Story = {
  args: {
    result: {
      ...evalResult,
      reasoning:
        "The answer includes the expected brands and supports each mention with evidence from the response.\n".repeat(
          12
        ),
    },
  },
}

export const NumericScores: Story = {
  render: () => (
    <div className="grid gap-4 text-sm sm:grid-cols-2">
      {[
        { name: "Below threshold", score: 0.5, passed: false },
        { name: "Zero score", score: 0, passed: false },
        { name: "At threshold", score: 0.8, passed: true },
        { name: "No pass/fail result", score: 0.5, passed: null },
      ].map(({ name, score, passed }) => (
        <div key={name} className="space-y-2">
          <p className="text-foreground-muted">{name}</p>
          <EvalScoreCell
            result={{
              ...evalResult,
              evaluatorName: name,
              metadata: {},
              score,
              passed,
              status: "completed",
              definition: passed === null ? undefined : evalResult.definition,
            }}
          />
        </div>
      ))}
    </div>
  ),
}
