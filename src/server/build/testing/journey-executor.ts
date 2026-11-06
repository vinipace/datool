import { randomUUID } from "node:crypto"
import type { WidgetDefinition } from "@/src/lib/build/contracts"
import {
  journeyStepLabel,
  journeyStepSchema,
  type AgentJourney,
  type JourneyResult,
} from "@/src/lib/build/agent-journey"
import { widgetAsCode } from "@/src/lib/build/widget-code"
import type { PromptRunScope } from "@/src/lib/tracer/prompt-overrides"
import { canonicalJson } from "@/src/lib/tracer/resource-document"
import {
  actionContinuation,
  runAgentTurn,
  type RunAgentTurnInput,
  type RunAgentTurnResult,
  type RuntimeContinuation,
} from "../runtime"
import type { AgentEvaluationTarget } from "../evaluation"
import { JourneyBrowser } from "./journey-browser"

function matchesInput(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>
) {
  return Object.entries(expected).every(
    ([key, value]) => canonicalJson(value) === canonicalJson(actual[key])
  )
}

/** Each case drives real widget controls and durable continuations on its own conversation. */
export async function executeJourneyEvaluation(
  target: AgentEvaluationTarget,
  message: string,
  journey: AgentJourney,
  callId: string,
  scope?: PromptRunScope,
  execution?: { assertActive: () => Promise<void> }
) {
  const context = {
    database: target.database,
    projectId: target.agent.projectId,
  }
  const cancellation = new AbortController()
  const signal = AbortSignal.any([
    AbortSignal.timeout(120_000),
    cancellation.signal,
  ])
  const assertActive = async () => {
    signal.throwIfAborted()
    try {
      await execution?.assertActive()
    } catch (error) {
      cancellation.abort(error)
      throw error
    }
  }
  let checking = false
  const monitor = execution
    ? setInterval(() => {
        if (checking || signal.aborted) return
        checking = true
        void assertActive()
          .catch(() => {})
          .finally(() => {
            checking = false
          })
      }, 1_000)
    : undefined
  const observed: Array<{
    actionId: string
    input: Record<string, unknown>
    status: string
  }> = []
  const answers: string[] = []
  const traceIds: string[] = []
  let missingMock: string | null = null
  let sequence = 0
  let current: RunAgentTurnResult | undefined
  let activeContinuation: RuntimeContinuation | undefined
  let activeDefinition: WidgetDefinition | undefined
  const report: JourneyResult = {
    name: journey.name,
    status: "passed",
    fingerprint: target.fingerprint,
    agentRevision: target.agent.currentRevision,
    width: journey.width,
    locale: journey.locale,
    steps: [],
    error: null,
  }
  const browser = new JourneyBrowser(journey.width, signal, journey.locale)
  let browserOpened = false
  const turn = async (
    value: Pick<RunAgentTurnInput, "message" | "metadata">
  ) => {
    await assertActive()
    const result = await runAgentTurn(
      context,
      {
        agentId: target.agent.id,
        channel: "web",
        ...(current
          ? { conversationId: current.conversation.id }
          : { externalConversationId: `eval:${callId}` }),
        requestKey: `eval:${callId}:${sequence++}`,
        ...value,
        metadata: {
          ...value.metadata,
          evalRunId: scope?.runId ?? null,
          evaluation: true,
        },
      },
      {
        agent: target.agent,
        catalog: target.catalog,
        signal,
        recordFormData: false,
        dependencies: {
          mockExternalActions: true,
          executeAction: async ({ action, input }) => {
            await assertActive()
            if (action.type === "widget" || action.type === "form") {
              const continuation = actionContinuation(
                action,
                input,
                randomUUID()
              )
              observed.push({ actionId: action.id, input, status: "succeeded" })
              return {
                status: "awaiting_client",
                output: continuation,
                continuation,
              }
            }
            const mock = journey.actionMocks.find(
              (mock) => mock.actionId === action.id
            )
            if (!mock)
              missingMock = `Add a test response for external action ${action.id}.`
            const error =
              mock?.error ??
              (!mock
                ? "External actions require a test mock during agent evaluations."
                : null)
            observed.push({
              actionId: action.id,
              input,
              status: error ? "failed" : "succeeded",
            })
            return error
              ? { status: "failed", output: { error } }
              : { status: "completed", output: mock?.response ?? null }
          },
        },
      }
    )
    current = result
    if (result.text) answers.push(result.text)
    if (result.traceId) traceIds.push(result.traceId)
    if (missingMock) throw new Error(missingMock)
    if (result.status === "busy")
      throw new Error("The agent could not complete this turn.")
    return result
  }
  const show = async () => {
    if (!current) return
    activeContinuation = current.continuations.find(
      (item) => item.type === "widget" || item.type === "form"
    )
    activeDefinition = undefined
    if (activeContinuation?.widgetId)
      activeDefinition = target.catalog.widgets.find(
        (widget) => widget.id === activeContinuation!.widgetId
      )?.definition
    if (activeContinuation?.type === "form") {
      const actionId =
        activeContinuation.submitActionId ?? activeContinuation.actionId
      activeDefinition = {
        name: activeContinuation.title ?? "Form",
        description: "",
        enabled: true,
        translations: activeContinuation.translations,
        code: 'export default function Widget({data}) { return <Form fields={data.fields} onSubmitAction="submit" submitLabel={data.submitLabel} /> }',
        components: [],
        states: {
          default: {
            fields: JSON.parse(JSON.stringify(activeContinuation.fields ?? [])),
            submitLabel: activeContinuation.submitLabel ?? "Submit",
          },
        },
        functions: [
          {
            name: "submit",
            actionId: actionId!,
            inputSchema: {},
            outputSchema: {},
          },
        ],
      }
    }
    if (activeContinuation && !activeDefinition)
      throw new Error(
        "The expected widget is unavailable in the saved agent version."
      )
    await browser.show(
      answers.at(-1) ?? "",
      activeDefinition
        ? {
            definition: activeDefinition,
            data: {
              ...activeDefinition.states.default,
              ...activeContinuation?.input,
            },
          }
        : undefined
    )
  }
  const afterAction = async () => {
    for (const action of await browser.actions()) {
      const definition = activeDefinition
      const continuation = activeContinuation
      const bound = definition
        ? widgetAsCode(definition).functions.find(
            (fn) => fn.name === action.functionName
          )
        : undefined
      if (!bound?.actionId || !continuation)
        throw new Error("The clicked widget control has no bound action.")
      await turn({
        message: action.label ?? bound.name,
        metadata: {
          widgetInteraction: JSON.parse(
            JSON.stringify({
              actionId: bound.actionId,
              widgetId: continuation.widgetId,
              continuationId: continuation.continuationId,
              input: action.input,
            })
          ),
        },
      })
      if (continuation.type === "form" && !continuation.submitActionId)
        observed.push({
          actionId: bound.actionId,
          input: action.input,
          status: "succeeded",
        })
      await show()
    }
  }
  try {
    try {
      await turn({ message, metadata: {} })
    } catch {
      report.status = "error"
      report.error =
        missingMock ??
        "The agent could not complete its initial turn. Inspect the linked trace for details."
    }
    report.steps.push({
      name: "Render the initial response",
      status: report.status,
      error: report.error,
    })
    if (report.status === "passed") {
      try {
        await browser.open()
        browserOpened = true
        await show()
      } catch (error) {
        report.status = browserOpened ? "failed" : "error"
        report.error = browserOpened
          ? String(error).slice(0, 2_000)
          : "The journey browser could not start. Check the browser installation on the worker."
        report.steps[0] = {
          ...report.steps[0],
          status: report.status,
          error: report.error,
        }
      }
    }
    if (journey.code && report.status === "passed") {
      try {
        await browser.runCode(journey.code, {
          afterAction,
          record: (step) => report.steps.push(step),
          agent: async (method, args) => {
            await assertActive()
            if (method === "sendMessage") {
              await turn({ message: String(args[0] ?? ""), metadata: {} })
              await show()
            } else if (method === "expectText") {
              await browser.step({
                type: "expect_text",
                text: String(args[0] ?? ""),
              })
            } else if (method === "expectHandoff") {
              const step = journeyStepSchema.parse({
                type: "expect_link",
                name: args[0],
                ...((args[1] as Record<string, unknown>) ?? {}),
              })
              if (step.type === "expect_link") await browser.step(step)
            } else if (method === "expectAction") {
              const step = journeyStepSchema.parse({
                type: "expect_action",
                actionId: args[0],
                input: args[1] ?? {},
              })
              if (
                step.type === "expect_action" &&
                !observed.some(
                  (action) =>
                    action.actionId === step.actionId &&
                    action.status === "succeeded" &&
                    matchesInput(step.input, action.input)
                )
              )
                throw new Error(
                  `The expected action ${step.actionId} did not succeed with the expected input.`
                )
            }
          },
        })
      } catch (error) {
        report.status = "failed"
        report.error =
          report.steps.findLast((step) => step.status === "failed")?.error ??
          String(error).slice(0, 2000)
        if (!report.steps.some((step) => step.status === "failed"))
          report.steps.push({
            name: "Run test code",
            status: "failed",
            error: report.error,
          })
      }
    }
    for (const step of journey.steps) {
      if (report.status !== "passed") {
        report.steps.push({
          name: journeyStepLabel(step),
          status: "skipped",
          error: null,
        })
        continue
      }
      try {
        await assertActive()
        if (step.type === "message") {
          await turn({ message: step.message, metadata: {} })
          await show()
        } else if (step.type === "expect_action") {
          if (
            !observed.some(
              (action) =>
                action.actionId === step.actionId &&
                action.status === "succeeded" &&
                matchesInput(step.input, action.input)
            )
          )
            throw new Error(
              `The expected action ${step.actionId} did not succeed with the expected input.`
            )
        } else {
          await browser.step(step)
          await afterAction()
        }
        report.steps.push({
          name: journeyStepLabel(step),
          status: "passed",
          error: null,
        })
      } catch (error) {
        report.status = "failed"
        report.error = String(error).slice(0, 2_000)
        report.steps.push({
          name: journeyStepLabel(step),
          status: "failed",
          error: report.error,
        })
      }
    }
    if (report.status !== "passed" && browserOpened) {
      const screenshot = await browser.screenshot()
      if (screenshot) report.screenshot = screenshot
    }
    return {
      text: answers.join("\n\n"),
      traceId: current?.traceId,
      traceIds,
      journey: report,
    }
  } finally {
    clearInterval(monitor)
    await browser.close()
  }
}
