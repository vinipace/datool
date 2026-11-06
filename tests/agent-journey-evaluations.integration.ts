import { expect, vi, test } from "vitest"
import { rejects } from "node:assert/strict"
import { sql } from "drizzle-orm"
import { createAgent, getAgent, updateAgent } from "@/src/server/build/agents"
import { saveAction, saveWidget } from "@/src/server/build/definitions"
import { TracerService } from "@/src/server/tracer/service"
import { runTracerEffect as run } from "@/src/server/tracer/effect"
import { getTracerProjectId } from "@/src/server/tracer/db"
import { encryptProviderKey } from "@/src/server/model-providers/secrets"
import {
  createTracerFixture,
  closeTracerFixture,
} from "./helpers/tracer-fixture"
import { defaultScorer } from "@/src/lib/tracer/scorers"
import { defaultLibraryScorer } from "@/src/lib/tracer/scorer-libraries"
import type { EvalRunDetail } from "@/src/lib/tracer/contracts"
import { agentJourneySchema } from "@/src/lib/build/agent-journey"
import { parseCreateEvalRun } from "@/src/server/tracer/validation"
import { createKnowledgeSource } from "@/src/server/build/knowledge/service"

const pickerCode = `import {useState} from "react"
import * as Shared from "@datool/widgets"
const ChoiceGroup=Shared.ChoiceGroup;
const DatePicker=Shared.DatePicker;
export default function Widget({data}) {
 const [selected,setSelected]=useState([]),[date,setDate]=useState(""),[city,setCity]=useState("");
 return <Col gap={12}><ChoiceGroup label="Models" options={[{id:"linen",label:"Linen shirt"},{id:"blue",label:"Blue romper"}]} value={selected} onChange={setSelected} multiple />
 <DatePicker label="Event date" value={date} onChange={setDate} />
 <label>City<input aria-label="City" value={city} onChange={e=>setCity(e.target.value)} /></label>
 <Button disabled={!selected.length||!date||!city} onClickAction={{functionName:"next",additionalInputs:{selectedModelIds:selected,date,city}}}>Continue</Button></Col>
}`
const summaryCode = `export default function Widget({data}) {return <Col><Text>Review your request</Text><Text>{data.date}</Text><a href={"https://wa.me/5511000000000?text="+encodeURIComponent("Request: "+data.selectedModelIds.join(", ")+"; "+data.date+"; "+data.city)}>Talk to team</a></Col>}`
const schemaCode =
  'import {z} from "zod";export default z.object({selectedModelIds:z.array(z.string()).default([]),date:z.string().default(""),city:z.string().default("")})'
const journey = agentJourneySchema.parse({
  name: "Personalized clothing",
  required: true,
  steps: [
    { type: "click", name: "Linen shirt" },
    { type: "click", name: "Blue romper" },
    { type: "fill", name: "Event date", value: "2030-12-30" },
    { type: "fill", name: "City", value: "São Paulo" },
    { type: "expect_selected", name: "Linen shirt" },
    { type: "expect_value", name: "Event date", value: "2030-12-30" },
    { type: "click", name: "Continue" },
    { type: "expect_text", text: "Review your request" },
    {
      type: "expect_link",
      name: "Talk to team",
      message: "linen, blue; 2030-12-30; São Paulo",
    },
    {
      type: "expect_action",
      actionId: "summary",
      input: {
        selectedModelIds: ["linen", "blue"],
        date: "2030-12-30",
        city: "São Paulo",
      },
    },
  ],
})

async function completed(service: TracerService, started: EvalRunDetail) {
  let result = started
  const deadline = Date.now() + 90_000
  while (
    ["queued", "running"].includes(result.status) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    result = await run(service.getEvalRun(result.id))
  }
  if (result.status !== "completed")
    throw new Error(
      JSON.stringify({
        status: result.status,
        rows: result.rows?.map((row) => ({
          stage: row.stage,
          error: row.executionError,
          trace: row.trace,
        })),
      }).slice(0, 6000)
    )
  expect(result.status).toBe("completed")
  return result
}

// Owns dataset -> real AI SDK/tool loop -> shipped sandbox -> continuation ->
// independent quality score + functional verdict -> exact-version publish gate.
test("agent journey evals drive controls and fence publishing by current cases and catalog", async () => {
  const database = await createTracerFixture()
  const projectId = getTracerProjectId(database)
  const context = { database, projectId }
  const service = new TracerService(database)
  const previousSecret = process.env.DATOOL_PROVIDER_ENCRYPTION_KEY
  process.env.DATOOL_PROVIDER_ENCRYPTION_KEY =
    "journey-evaluation-local-fixture-secret"
  const requests: string[] = []
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
    url,
    init
  ) => {
    if (String(url) === "https://models.dev/api.json") return Response.json({})
    requests.push(String(url))
    expect(String(url)).toBe("https://api.openai.com/v1/responses")
    const body = JSON.parse(String(init?.body))
    expect(body.store).toBe(false)
    return Response.json({
      id: `resp_${requests.length}`,
      object: "response",
      created_at: 1792784000,
      model: body.model,
      status: "completed",
      output: [
        {
          type: "message",
          id: `msg_${requests.length}`,
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "Choose your options.",
              annotations: [],
            },
          ],
        },
        {
          type: "function_call",
          id: `fc_${requests.length}`,
          call_id: `call_${requests.length}`,
          name: "models",
          arguments: "{}",
          status: "completed",
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    })
  }) as typeof fetch)
  try {
    await rejects(
      createAgent(context, {
        name: "Untested gated agent",
        configuration: { testing: { requirePassingJourneys: true } },
      }),
      /Create the agent first/
    )
    await database.execute(
      sql`insert into project_model_provider(project_id,provider,encrypted_api_key) values (${projectId},'openai',${encryptProviderKey("fixture-provider-key", projectId, "openai")})`
    )
    let agent = await createAgent(context, {
      name: "Clothing helper",
      configuration: {
        provider: "openai",
        model: "gpt-4.1-mini",
        channelAllowlist: ["web"],
      },
    })
    const action = (id: string, widgetId: string) =>
      saveAction(context, agent.id, {
        id,
        slug: id,
        definition: {
          id,
          type: "widget",
          name: id,
          description: "Show the next request step",
          widgetId,
          eventName: "show",
          enabled: true,
          channels: ["web"],
          inputSchema: {},
          procedureOnly: false,
        },
      })
    // References are validated when actions/widgets are saved. Start with an
    // unbound picker, then bind it once both widgets/actions exist.
    const base = {
      name: "Picker",
      code: pickerCode,
      schemaCode,
      states: { default: {} },
    }
    let picker = await saveWidget(context, agent.id, {
      id: "picker",
      definition: base,
    })
    await saveWidget(context, agent.id, {
      id: "summary-widget",
      definition: {
        name: "Summary",
        code: summaryCode,
        schemaCode,
        states: { default: {} },
      },
    })
    await action("models", "picker")
    await action("summary", "summary-widget")
    picker = await saveWidget(context, agent.id, {
      id: picker.id,
      expectedRevision: picker.revision,
      definition: {
        ...base,
        functions: [{ name: "next", actionId: "summary" }],
      },
    })
    agent = await updateAgent(context, agent.id, {
      expectedRevision: agent.currentRevision,
      configuration: {
        ...agent.configuration,
        testing: { requirePassingJourneys: true },
      },
      apply: false,
    })
    const dataset = await run(
      service.createDataset({ agentId: agent.id, name: "Customer journeys" })
    )
    const item = await run(
      service.createDatasetItem(dataset.id, {
        input: { message: "I want a custom outfit", channel: "web", journey },
        expectedOutput: "Choose your options.",
      })
    )
    const scorer = await run(
      service.scorers.save({
        ...defaultScorer,
        name: "Useful answer",
        slug: "useful-answer",
        type: "library",
        threshold: 1,
        library: defaultLibraryScorer("ExactMatch"),
      })
    )
    const gate = (id: string) =>
      run(
        service.agent.gateEval({
          id,
          minScore: 1,
          minPassRate: 1,
          maxErrors: 0,
          allowUnscored: false,
          maxRegression: 0,
        })
      )
    await rejects(
      updateAgent(context, agent.id, {
        expectedRevision: agent.currentRevision,
        apply: true,
      }),
      /Run and pass/
    )
    const functionalOnly = await completed(
      service,
      await run(
        service.createEvalRun(
          parseCreateEvalRun({
            agentId: agent.id,
            datasetId: dataset.id,
            evaluatorIds: [],
          })
        )
      )
    )
    expect(() =>
      parseCreateEvalRun({ datasetId: dataset.id, evaluatorIds: [] })
    ).toThrow()
    expect((await gate(functionalOnly.id)).passed).toBe(true)
    expect(
      (
        await run(
          service.listDatasetItems(dataset.id, { includeResults: true })
        )
      ).items[0].latestEvaluation
    ).toMatchObject({
      outcome: "passed",
      score: null,
      functional: { status: "passed" },
    })
    // The authored code passes through the same browser, continuations, scores
    // and publication gate as legacy saved steps.
    const codeJourney = agentJourneySchema.parse({
      name: "Personalized clothing",
      required: true,
      code: `
        await test.step("Choose both models", async () => {
          for (const name of ["Linen shirt", "Blue romper"]) {
            const model = page.getByRole("button", {name, exact:true});
            await model.click();
            await expect(model).toHaveAttribute("aria-pressed", "true");
          }
        });
        await page.getByLabel("Event date").fill("2030-12-30");
        await page.getByLabel("City").fill("São Paulo");
        await expect(page.getByLabel("Event date")).toHaveValue("2030-12-30");
        await page.getByRole("button", {name:"Continue", exact:true}).click();
        await expect(page.getByText("Review your request")).toBeVisible();
        const href = await page.getByRole("link", {name:"Talk to team"}).getAttribute("href");
        await expect(new URL(href).searchParams.get("text")).toContain("linen, blue; 2030-12-30; São Paulo");
        await agent.expectAction("summary", {selectedModelIds:["linen","blue"],date:"2030-12-30",city:"São Paulo"});
      `,
    })
    await run(
      service.patchDatasetItem(item.id, {
        input: {
          message: "I want a custom outfit",
          channel: "web",
          journey: codeJourney,
        },
      })
    )
    const result = await completed(
      service,
      await run(
        service.createEvalRun({
          agentId: agent.id,
          datasetId: dataset.id,
          evaluatorIds: [scorer.id],
        })
      )
    )
    const first = (
      await run(service.listDatasetItems(dataset.id, { includeResults: true }))
    ).items[0].latestEvaluation!
    expect(first).toMatchObject({
      outcome: "passed",
      score: 1,
      functional: { status: "passed", name: "Personalized clothing" },
    })
    expect(
      first.functional!.steps.every((step) => step.status === "passed")
    ).toBe(true)
    expect((await gate(result.id)).passed).toBe(true)
    expect(result.rows![0].trace.output).toContain("Choose your options.")
    agent = await updateAgent(context, agent.id, {
      expectedRevision: agent.currentRevision,
      apply: true,
    })
    expect(agent.appliedRevision).toBe(agent.currentRevision)

    // A changed case cannot reuse a prior pass, even with an unchanged agent.
    await run(
      service.patchDatasetItem(item.id, {
        expectedOutput: "A different expected answer",
      })
    )
    await rejects(
      updateAgent(context, agent.id, {
        expectedRevision: agent.currentRevision,
        apply: true,
      }),
      /Run and pass/
    )
    await run(
      service.patchDatasetItem(item.id, {
        expectedOutput: "Choose your options.",
      })
    )
    await createKnowledgeSource(context, {
      agentId: agent.id,
      kind: "text",
      name: "New policy",
      text: "Custom clothing is reviewed by the team.",
    })
    await rejects(
      updateAgent(context, agent.id, {
        expectedRevision: agent.currentRevision,
        apply: true,
      }),
      /Run and pass/
    )

    // A passing answer score must never average away a browser failure. New
    // catalog content also invalidates the earlier publication receipt.
    await saveWidget(context, agent.id, {
      id: picker.id,
      expectedRevision: picker.revision,
      definition: {
        ...picker.definition,
        code: 'export default function Widget() {throw new Error("Broken model picker")}',
      },
    })
    await rejects(
      updateAgent(context, agent.id, {
        expectedRevision: agent.currentRevision,
        apply: true,
      }),
      /Run and pass/
    )
    const failed = await completed(
      service,
      await run(
        service.createEvalRun({
          agentId: agent.id,
          datasetId: dataset.id,
          evaluatorIds: [scorer.id],
        })
      )
    )
    expect(await gate(failed.id)).toMatchObject({
      passed: false,
      run: { score: 1, passRate: 1, journeys: 1, journeysPassed: 0 },
    })
    const broken = (
      await run(service.listDatasetItems(dataset.id, { includeResults: true }))
    ).items[0].latestEvaluation!
    expect(broken).toMatchObject({
      outcome: "failed",
      score: 1,
      functional: { status: "failed" },
    })
    expect(broken.functional!.error).toContain("Broken model picker")
    expect(broken.functional!.screenshot).toMatch(/^data:image\/png;base64,/)
    expect(
      broken
        .functional!.steps.slice(1)
        .every((step) => step.status === "skipped")
    ).toBe(true)
    await rejects(
      updateAgent(context, agent.id, {
        expectedRevision: agent.currentRevision,
        apply: true,
      }),
      /Run and pass/
    )
    expect((await getAgent(context, agent.id)).appliedRevision).toBe(
      agent.appliedRevision
    )
    expect(requests).toEqual(
      Array(requests.length).fill("https://api.openai.com/v1/responses")
    )
  } finally {
    fetchSpy.mockRestore()
    if (previousSecret === undefined)
      delete process.env.DATOOL_PROVIDER_ENCRYPTION_KEY
    else process.env.DATOOL_PROVIDER_ENCRYPTION_KEY = previousSecret
    await closeTracerFixture(database)
  }
}, 120_000)

test("journey evaluations mock external actions and submit forms without creating live leads", async () => {
  const database = await createTracerFixture()
  const projectId = getTracerProjectId(database)
  const context = { database, projectId }
  const service = new TracerService(database)
  const previousSecret = process.env.DATOOL_PROVIDER_ENCRYPTION_KEY
  process.env.DATOOL_PROVIDER_ENCRYPTION_KEY =
    "journey-side-effects-fixture-secret"
  let action = "capture"
  let requested = false
  let pausedRequest: { started: () => void; stopped: () => void } | null = null
  const requests: string[] = []
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
    url,
    init
  ) => {
    if (String(url) === "https://models.dev/api.json") return Response.json({})
    requests.push(String(url))
    expect(String(url)).toBe("https://api.openai.com/v1/responses")
    const body = JSON.parse(String(init?.body))
    const shouldCall =
      !requested &&
      body.tools?.some((tool: { name: string }) => tool.name === action)
    if (shouldCall && pausedRequest) {
      const paused = pausedRequest
      return await new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          paused.stopped()
          reject(new Error("Fixture request cancelled."))
        }
        init!.signal!.addEventListener("abort", abort, { once: true })
        paused.started()
        if (init!.signal!.aborted) abort()
      })
    }
    const output = shouldCall
      ? [
          {
            type: "function_call",
            id: `fc_${requests.length}`,
            call_id: `call_${requests.length}`,
            name: action,
            arguments: "{}",
            status: "completed",
          },
        ]
      : [
          {
            type: "message",
            id: `msg_${requests.length}`,
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "Request recorded for the test.",
                annotations: [],
              },
            ],
          },
        ]
    if (shouldCall) requested = true
    return Response.json({
      id: `resp_${requests.length}`,
      object: "response",
      created_at: 1792784000,
      model: "gpt-4.1-mini",
      status: "completed",
      output,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    })
  }) as typeof fetch)
  try {
    await database.execute(
      sql`insert into project_model_provider(project_id,provider,encrypted_api_key) values (${projectId},'openai',${encryptProviderKey("fixture-provider-key", projectId, "openai")})`
    )
    const agent = await createAgent(context, {
      name: "Request helper",
      configuration: {
        provider: "openai",
        model: "gpt-4.1-mini",
        channelAllowlist: ["web"],
      },
    })
    await saveAction(context, agent.id, {
      id: "capture",
      slug: "capture",
      definition: {
        id: "capture",
        name: "Collect email",
        type: "form",
        captureLead: true,
        submitLabel: "Continue",
        fields: [
          { name: "email", label: "Email", type: "email", required: true },
        ],
      },
    })
    await saveAction(context, agent.id, {
      id: "external",
      slug: "external",
      definition: {
        id: "external",
        name: "Create request",
        type: "http",
        method: "POST",
        url: "https://example.com/orders",
      },
    })
    const dataset = await run(
      service.createDataset({ agentId: agent.id, name: "Side effects" })
    )
    const item = await run(
      service.createDatasetItem(dataset.id, {
        input: {
          message: "I want to leave my email",
          journey: agentJourneySchema.parse({
            name: "Email capture",
            steps: [
              { type: "fill", name: "Email", value: "fixture@example.com" },
              { type: "click", name: "Continue" },
              {
                type: "expect_action",
                actionId: "capture",
                input: { email: "fixture@example.com" },
              },
            ],
          }),
        },
      })
    )
    const forms = await completed(
      service,
      await run(
        service.createEvalRun({
          agentId: agent.id,
          datasetId: dataset.id,
          evaluatorIds: [],
        })
      )
    )
    expect(
      (
        await run(
          service.listDatasetItems(dataset.id, { includeResults: true })
        )
      ).items[0].latestEvaluation
    ).toMatchObject({ outcome: "passed" })
    const records = await database.execute(
      sql`select (select count(*) from build_contacts where project_id=${projectId}) as contacts,(select count(*) from build_leads where project_id=${projectId}) as leads,(select count(*) from build_collected_data where project_id=${projectId}) as data`
    )
    expect(records.rows[0]).toEqual({ contacts: "0", leads: "0", data: "0" })
    expect(forms.rows![0].trace.input).toEqual(item.input)

    action = "external"
    const external = {
      message: "Please create a request",
      journey: agentJourneySchema.parse({
        name: "Mocked request",
        steps: [{ type: "expect_action", actionId: "external", input: {} }],
        actionMocks: [{ actionId: "external", response: { id: "test-order" } }],
      }),
    }
    await run(service.patchDatasetItem(item.id, { input: external }))
    requested = false
    await completed(
      service,
      await run(
        service.createEvalRun({
          agentId: agent.id,
          datasetId: dataset.id,
          evaluatorIds: [],
        })
      )
    )
    expect(
      (
        await run(
          service.listDatasetItems(dataset.id, { includeResults: true })
        )
      ).items[0].latestEvaluation
    ).toMatchObject({ outcome: "passed" })

    await run(
      service.patchDatasetItem(item.id, {
        input: {
          ...external,
          journey: { ...external.journey, actionMocks: [] },
        },
      })
    )
    requested = false
    await completed(
      service,
      await run(
        service.createEvalRun({
          agentId: agent.id,
          datasetId: dataset.id,
          evaluatorIds: [],
        })
      )
    )
    expect(
      (
        await run(
          service.listDatasetItems(dataset.id, { includeResults: true })
        )
      ).items[0].latestEvaluation
    ).toMatchObject({
      outcome: "failed",
      functional: {
        status: "error",
        error: "Add a test response for external action external.",
      },
    })
    expect(requests).toEqual(
      Array(requests.length).fill("https://api.openai.com/v1/responses")
    )
    await run(service.patchDatasetItem(item.id, { input: external }))
    requested = false
    let started!: () => void
    let stopped!: () => void
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const requestStopped = new Promise<void>((resolve) => {
      stopped = resolve
    })
    pausedRequest = { started, stopped }
    const cancelling = await run(
      service.createEvalRun({
        agentId: agent.id,
        datasetId: dataset.id,
        evaluatorIds: [],
      })
    )
    await requestStarted
    await run(service.cancelEvalRun(cancelling.id))
    await requestStopped
    expect((await run(service.getEvalRun(cancelling.id))).status).toBe(
      "cancelled"
    )
    const deadline = Date.now() + 5_000
    while (
      (await run(service.getTraceArtifact(cancelling.rows![0].trace.id)))
        .status === "running" &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 20))
    expect(
      (await run(service.getTraceArtifact(cancelling.rows![0].trace.id))).status
    ).toBe("completed")
    expect(
      (
        await run(
          service.listDatasetItems(dataset.id, { includeResults: true })
        )
      ).items[0].latestEvaluation
    ).toMatchObject({ outcome: "cancelled" })
  } finally {
    fetchSpy.mockRestore()
    if (previousSecret === undefined)
      delete process.env.DATOOL_PROVIDER_ENCRYPTION_KEY
    else process.env.DATOOL_PROVIDER_ENCRYPTION_KEY = previousSecret
    await closeTracerFixture(database)
  }
}, 120_000)
