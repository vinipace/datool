import assert from "node:assert/strict"
import { join } from "node:path"
import type { Page } from "playwright"
import { selectAgentSection } from "./build-e2e-ui"

type BuildOperationInput = Record<string, unknown>
type BuildOperationCall = (
  name: string,
  input?: BuildOperationInput
) => Promise<unknown>

export type BuildAuthoringE2eOptions = {
  page: Page
  /** Project-scoped Build URL, for example /p/test-project/build. */
  prefix: string
  agentId: string
  call: BuildOperationCall
  passed: (message: string) => void
  evidence: string
}

type RecordValue = Record<string, unknown>

function record(value: unknown, label: string): RecordValue {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`
  )
  return value as RecordValue
}

function records(value: unknown, label: string): RecordValue[] {
  if (Array.isArray(value))
    return value.map((item, index) => record(item, `${label}[${index}]`))
  const container = record(value, label)
  for (const key of ["items", "actions", "procedures", "widgets"]) {
    if (Array.isArray(container[key]))
      return (container[key] as unknown[]).map((item, index) =>
        record(item, `${label}.${key}[${index}]`)
      )
  }
  assert.fail(`${label} must contain an array of records`)
}

function stringValue(value: unknown, label: string): string {
  assert.equal(typeof value, "string", `${label} must be a string`)
  return value as string
}

function numberValue(value: unknown, label: string): number {
  assert.equal(typeof value, "number", `${label} must be a number`)
  return value as number
}

function definition(recordValue: RecordValue, label: string) {
  return record(recordValue.definition, `${label}.definition`)
}

function escaped(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function setSwitch(page: Page, name: string, checked: boolean) {
  const control = page.getByRole("switch", { name, exact: true })
  await control.waitFor()
  const current = (await control.getAttribute("aria-checked")) === "true"
  if (current !== checked) await control.click()
  assert.equal(
    await control.getAttribute("aria-checked"),
    String(checked),
    `${name} switch must be ${checked ? "enabled" : "disabled"}`
  )
}

async function waitForStatus(page: Page, message: string) {
  await page.getByRole("status").filter({ hasText: message }).last().waitFor()
}

async function saveThroughUi(
  page: Page,
  operation: string,
  click: () => Promise<void>
) {
  const responsePromise = page.waitForResponse((response) => {
    const pathname = new URL(response.url()).pathname
    return (
      response.request().method() === "POST" &&
      pathname.endsWith(`/api/build/${operation}`)
    )
  })
  const appliedPromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/api/build/build_update_agent")
  )
  await click()
  const response = await responsePromise
  assert(response.ok(), `${operation} returned HTTP ${response.status()}`)
  const payload = record(await response.json(), `${operation} response`)
  const applied = await appliedPromise
  assert(applied.ok(), `Agent autosave returned HTTP ${applied.status()}`)
  const appliedAgent = record(
    record(await applied.json(), "agent autosave response").data,
    "applied agent"
  )
  assert(Number.isInteger(appliedAgent.currentRevision))
  assert.equal(appliedAgent.appliedRevision, appliedAgent.currentRevision)
  // The full-screen widget editor hides the parent agent's status region.
  await page
    .getByText("Saved", { exact: true })
    .filter({ visible: true })
    .last()
    .waitFor()
  return record(payload.data, `${operation} data`)
}

async function revisions(
  call: BuildOperationCall,
  operation: string,
  input: BuildOperationInput,
  label: string
) {
  const items = records(await call(operation, input), label)
  const values = items
    .map((item) => numberValue(item.revision, `${label}.revision`))
    .sort((left, right) => left - right)
  return values
}

async function setWidgetCode(page: Page, code: string) {
  const editor = page.getByRole("textbox", {
    name: "Widget code",
    exact: true,
  })
  await editor.press("ControlOrMeta+A")
  await page.keyboard.insertText(code)
}

/**
 * Exercises the existing Actions, Procedures and Widgets editors through the
 * browser. Definitions are deliberately disabled and client-side so this
 * check proves persistence and apply semantics without making provider or
 * network requests during the run.
 */
export async function runBuildAuthoringE2e({
  page,
  prefix,
  agentId,
  call,
  passed,
  evidence,
}: BuildAuthoringE2eOptions) {
  const suffix = `${agentId.slice(0, 8)}-${Date.now()}`
  const actionId = `e2e-client-${suffix}`
  const actionName = `E2E client action ${suffix}`
  const editedActionName = `${actionName} edited`
  const procedureName = `E2E disabled procedure ${suffix}`
  const editedProcedureName = `${procedureName} edited`
  const widgetName = `E2E disabled widget ${suffix}`
  const editedWidgetName = `${widgetName} edited`
  const initialWidgetCode =
    "export default function Widget() { return <Text>Initial widget copy</Text> }"
  const editedWidgetCode =
    "export default function Widget() { return <Text>Edited widget copy</Text> }"

  await page.goto(`${prefix}/agents/${encodeURIComponent(agentId)}`, {
    waitUntil: "networkidle",
    timeout: 120_000,
  })
  await selectAgentSection(page, "Actions")
  await page.getByRole("tab", { name: "Templates", exact: true }).click()
  await page
    .getByRole("button", { name: "Run client-side code", exact: true })
    .click()
  await page.getByText("Advanced identity", { exact: true }).click()
  await page.locator("#action-id").fill(actionId)
  await page.locator("#action-name").fill(actionName)
  await page
    .getByRole("textbox", { name: "Action description", exact: true })
    .fill("Disabled client action used by the authoring browser check.")
  await page.locator("#action-event").fill(`e2e.client.${suffix}`)
  await page.getByText("Availability", { exact: true }).click()
  await setSwitch(page, "Enabled", false)
  await setSwitch(page, "Procedure only", true)
  await saveThroughUi(page, "build_save_action", () =>
    page.getByRole("button", { name: "Create action", exact: true }).click()
  )
  await waitForStatus(page, "Action created.")

  const createdAction = record(
    await call("build_get_action", { agentId, actionId }),
    "created action"
  )
  assert.equal(createdAction.id, actionId)
  assert.equal(createdAction.revision, 1)
  const createdActionDefinition = definition(createdAction, "created action")
  assert.equal(createdActionDefinition.type, "client")
  assert.equal(createdActionDefinition.enabled, false)
  assert.equal(createdActionDefinition.procedureOnly, true)
  assert.equal(createdActionDefinition.eventName, `e2e.client.${suffix}`)

  const actionRow = page.getByRole("button", { name: actionName, exact: true })
  await actionRow.waitFor()
  await actionRow.click()
  await page.locator("#action-name").fill(editedActionName)
  await page
    .getByRole("textbox", { name: "Action description", exact: true })
    .fill("Edited disabled client action used by the authoring browser check.")
  await saveThroughUi(page, "build_save_action", () =>
    page.getByRole("button", { name: "Save action", exact: true }).click()
  )
  await waitForStatus(page, "Action updated.")

  const editedAction = record(
    await call("build_get_action", { agentId, actionId }),
    "edited action"
  )
  assert.equal(editedAction.revision, 2)
  assert.equal(definition(editedAction, "edited action").name, editedActionName)
  assert.deepEqual(
    await revisions(
      call,
      "build_list_action_revisions",
      { agentId, actionId },
      "action revisions"
    ),
    [1, 2]
  )
  await page.screenshot({
    path: join(evidence, "authoring-action-edited.png"),
    fullPage: true,
  })

  await selectAgentSection(page, "Procedures")
  await page.getByRole("heading", { name: "Procedures", exact: true }).waitFor()
  await page.getByRole("button", { name: "New", exact: true }).click()
  await page.locator("#procedure-name").fill(procedureName)
  await page
    .getByRole("textbox", { name: "Procedure description", exact: true })
    .fill("Disabled procedure containing the client action reference.")
  await setSwitch(page, "Enabled", false)
  await page.locator("#procedure-trigger-type").selectOption("manual")
  await page.locator("#procedure-trigger-value").fill(`e2e-manual-${suffix}`)
  await page
    .getByRole("textbox", { name: "Step 1 message", exact: true })
    .fill(
      "This disabled procedure is persisted by the browser authoring check."
    )
  await page.getByText("Action references (JSON)", { exact: true }).click()
  await page
    .getByRole("textbox", {
      name: "Procedure action references JSON",
      exact: true,
    })
    .fill(JSON.stringify([actionId]))
  const createdProcedureResponse = await saveThroughUi(
    page,
    "build_save_procedure",
    () =>
      page
        .getByRole("button", { name: "Create procedure", exact: true })
        .click()
  )
  await waitForStatus(page, "Procedure created.")

  const procedureId = stringValue(createdProcedureResponse.id, "procedure id")
  const procedureAfterCreate = record(
    await call("build_get_procedure", { agentId, procedureId }),
    "created procedure"
  )
  assert.equal(procedureAfterCreate.id, procedureId)
  assert.equal(procedureAfterCreate.revision, 1)
  const procedureDefinition = definition(
    procedureAfterCreate,
    "procedure after create"
  )
  assert.equal(procedureDefinition.enabled, false)
  assert.deepEqual(procedureDefinition.actionRefs, [actionId])
  assert.equal(
    record(procedureDefinition.trigger, "procedure trigger").type,
    "manual"
  )

  await page
    .getByRole("region", { name: "Procedures" })
    .getByRole("button", { name: new RegExp(escaped(procedureName)) })
    .click()
  await page.locator("#procedure-name").fill(editedProcedureName)
  await page.locator("#procedure-trigger-value").fill(`e2e-edited-${suffix}`)
  await page
    .getByRole("textbox", { name: "Step 1 message", exact: true })
    .fill("Edited disabled procedure content survives a reload.")
  await saveThroughUi(page, "build_save_procedure", () =>
    page.getByRole("button", { name: "Save procedure", exact: true }).click()
  )
  await waitForStatus(page, "Procedure updated.")

  const procedureAfterEdit = record(
    await call("build_get_procedure", { agentId, procedureId }),
    "edited procedure"
  )
  assert.equal(procedureAfterEdit.id, procedureId)
  assert.equal(procedureAfterEdit.revision, 2)
  assert.equal(
    record(
      definition(procedureAfterEdit, "procedure after edit").trigger,
      "edited procedure trigger"
    ).value,
    `e2e-edited-${suffix}`
  )
  assert.deepEqual(
    await revisions(
      call,
      "build_list_procedure_revisions",
      { agentId, procedureId },
      "procedure revisions"
    ),
    [1, 2]
  )

  await selectAgentSection(page, "Widgets")
  await page.getByRole("button", { name: "New widget", exact: true }).click()
  await page
    .getByRole("textbox", { name: "Widget name", exact: true })
    .fill(widgetName)
  await setWidgetCode(page, initialWidgetCode)
  await page.getByRole("tab", { name: "Settings", exact: true }).click()
  await page
    .getByRole("textbox", { name: "Description", exact: true })
    .fill("Disabled widget used by the authoring browser check.")
  await setSwitch(page, "Enable widget", false)
  const createdWidgetResponse = await saveThroughUi(
    page,
    "build_save_widget",
    () =>
      page.getByRole("button", { name: "Create widget", exact: true }).click()
  )

  const widgetId = stringValue(createdWidgetResponse.id, "widget id")
  const widgetAfterCreate = record(
    await call("build_get_widget", { agentId, widgetId }),
    "created widget"
  )
  assert.equal(widgetAfterCreate.id, widgetId)
  assert.equal(widgetAfterCreate.revision, 1)
  const widgetDefinition = definition(widgetAfterCreate, "widget after create")
  assert.equal(widgetDefinition.enabled, false)
  assert.equal(String(widgetDefinition.code).trim(), initialWidgetCode)

  await page
    .getByRole("button", { name: "Back to widgets", exact: true })
    .click()
  await page
    .getByRole("region", { name: "Widgets" })
    .getByRole("button", { name: widgetName, exact: true })
    .click()
  await page
    .getByRole("textbox", { name: "Widget name", exact: true })
    .fill(editedWidgetName)
  await setWidgetCode(page, editedWidgetCode)
  await page.getByRole("tab", { name: "Settings", exact: true }).click()
  await page
    .getByRole("textbox", { name: "Description", exact: true })
    .fill("Edited disabled widget used by the authoring browser check.")
  await saveThroughUi(page, "build_save_widget", () =>
    page.getByRole("button", { name: "Save changes", exact: true }).click()
  )

  const widgetAfterEdit = record(
    await call("build_get_widget", { agentId, widgetId }),
    "edited widget"
  )
  assert.equal(widgetAfterEdit.id, widgetId)
  assert.equal(widgetAfterEdit.revision, 2)
  assert.equal(
    String(definition(widgetAfterEdit, "widget after edit").code).trim(),
    editedWidgetCode
  )
  assert.deepEqual(
    await revisions(
      call,
      "build_list_widget_revisions",
      { agentId, widgetId },
      "widget revisions"
    ),
    [1, 2]
  )
  passed(
    "browser creates and edits disabled client, procedure and widget definitions"
  )

  // A fresh browser form must hydrate the saved definitions before the final
  // mutation. This also catches forms that only update local state after save.
  await page.reload({ waitUntil: "networkidle", timeout: 120_000 })
  await selectAgentSection(page, "Actions")
  await page
    .getByRole("button", { name: editedActionName, exact: true })
    .click()
  assert.equal(
    await page.locator("#action-name").inputValue(),
    editedActionName
  )
  assert.equal(
    await page.locator("#action-event").inputValue(),
    `e2e.client.${suffix}`
  )
  await page.getByText("Availability", { exact: true }).click()
  assert.equal(
    await page
      .getByRole("switch", { name: "Enabled", exact: true })
      .getAttribute("aria-checked"),
    "false"
  )
  assert.equal(
    await page
      .getByRole("switch", { name: "Procedure only", exact: true })
      .getAttribute("aria-checked"),
    "true"
  )
  await page.getByRole("button", { name: "Cancel", exact: true }).click()

  await selectAgentSection(page, "Procedures")
  await page
    .getByRole("region", { name: "Procedures" })
    .getByRole("button", { name: new RegExp(escaped(editedProcedureName)) })
    .click()
  assert.equal(
    await page.locator("#procedure-name").inputValue(),
    editedProcedureName
  )
  assert.equal(
    await page.locator("#procedure-trigger-value").inputValue(),
    `e2e-edited-${suffix}`
  )
  await setSwitch(page, "Enabled", false)

  await selectAgentSection(page, "Widgets")
  await page
    .getByRole("region", { name: "Widgets" })
    .getByRole("button", { name: new RegExp(escaped(editedWidgetName)) })
    .click()
  assert.equal(
    await page
      .getByRole("textbox", { name: "Widget name", exact: true })
      .inputValue(),
    editedWidgetName
  )
  await page
    .frameLocator(
      '[aria-label="Widget preview"] iframe[title="Widget content"]'
    )
    .getByText("Edited widget copy", { exact: true })
    .waitFor()
  await page.getByRole("tab", { name: "Settings", exact: true }).click()
  await setSwitch(page, "Enable widget", false)
  passed(
    "browser reload hydrates persisted definition names, revisions and fields"
  )

  // Saving a post-reload definition must also apply it automatically.
  // The action remains client-side and disabled throughout.
  await page
    .getByRole("textbox", { name: "Description", exact: true })
    .fill("Edited disabled widget is ready for the applied draft.")
  await saveThroughUi(page, "build_save_widget", () =>
    page.getByRole("button", { name: "Save changes", exact: true }).click()
  )
  const widgetAfterReloadEdit = record(
    await call("build_get_widget", { agentId, widgetId }),
    "widget after reload edit"
  )
  assert.equal(widgetAfterReloadEdit.revision, 3)
  assert.equal(
    definition(widgetAfterReloadEdit, "widget after reload edit").description,
    "Edited disabled widget is ready for the applied draft."
  )
  assert.deepEqual(
    await revisions(
      call,
      "build_list_widget_revisions",
      { agentId, widgetId },
      "widget revisions after reload edit"
    ),
    [1, 2, 3]
  )

  await page
    .getByRole("button", { name: "Back to widgets", exact: true })
    .click()
  const appliedAgent = record(
    await call("build_get_agent", { agentId }),
    "applied agent"
  )
  assert.equal(appliedAgent.currentRevision, appliedAgent.appliedRevision)
  assert(
    numberValue(appliedAgent.currentRevision, "applied agent revision") > 0
  )
  await page.screenshot({
    path: join(evidence, "authoring-applied.png"),
    fullPage: true,
  })
  passed(
    "browser automatically applies saved definitions and publishes matching agent revisions"
  )
}
