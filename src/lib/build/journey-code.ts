import { journeyStepSchema, type JourneyStep } from "./agent-journey"

/** Preserve saved journeys when their author switches to the code editor. */
export function journeyStepsToCode(steps: unknown[]): string {
  const text = (value: unknown) => JSON.stringify(value)
  return steps
    .map((value) => {
      const parsed = journeyStepSchema.safeParse(value)
      if (!parsed.success) return "// Complete this test step."
      const step: JourneyStep = parsed.data
      const field =
        "name" in step
          ? `page.getByLabel(${text(step.name)}, { exact: true })`
          : ""
      switch (step.type) {
        case "click":
          return `await page.getByRole(${text(step.role)}, { name: ${text(step.name)}, exact: true }).click();`
        case "fill":
          return `await ${field}.fill(${text(step.value)});`
        case "select":
          return `await ${field}.selectOption(${text(step.value)});`
        case "check":
          return `await page.getByRole("checkbox", { name: ${text(step.name)}, exact: true }).setChecked(${step.checked});`
        case "expect_text":
          return `await agent.expectText(${text(step.text)});`
        case "expect_value":
          return `await expect(${field}).toHaveValue(${text(step.value)});`
        case "expect_selected":
          return `await expect(page.getByRole("button", { name: ${text(step.name)}, exact: true })).toHaveAttribute("aria-pressed", ${text(String(step.selected))});`
        case "expect_link":
          return `await agent.expectHandoff(${text(step.name)}, ${text({ ...(step.href ? { href: step.href } : {}), ...(step.message !== undefined ? { message: step.message } : {}) })});`
        case "expect_action":
          return `await agent.expectAction(${text(step.actionId)}, ${text(step.input)});`
        case "message":
          return `await agent.sendMessage(${text(step.message)});`
      }
    })
    .join("\n")
}

export const journeyCodeDeclarations = `
type TestLocator = {
  getByRole(role: string, options?: {name?: string; exact?: boolean}): TestLocator;
  getByLabel(text: string, options?: {exact?: boolean}): TestLocator;
  getByText(text: string, options?: {exact?: boolean}): TestLocator;
  getByPlaceholder(text: string, options?: {exact?: boolean}): TestLocator;
  getByTestId(id: string): TestLocator;
  locator(selector: string): TestLocator;
  first(): TestLocator; last(): TestLocator; nth(index: number): TestLocator;
  click(): Promise<void>; fill(value: string): Promise<void>;
  selectOption(value: string): Promise<void>; setChecked(value: boolean): Promise<void>;
  check(): Promise<void>; uncheck(): Promise<void>;
  getAttribute(name: string): Promise<string | null>;
  innerText(): Promise<string>; textContent(): Promise<string | null>;
  inputValue(): Promise<string>; count(): Promise<number>;
  isVisible(): Promise<boolean>; isEnabled(): Promise<boolean>; isChecked(): Promise<boolean>;
};
type TestAssertions = {
  readonly not: TestAssertions;
  toBeVisible(): Promise<void>; toBeHidden(): Promise<void>;
  toBeEnabled(): Promise<void>; toBeDisabled(): Promise<void>; toBeChecked(): Promise<void>;
  toHaveText(value: string): Promise<void>; toContainText(value: string): Promise<void>;
  toHaveValue(value: string): Promise<void>; toHaveAttribute(name: string, value: string): Promise<void>;
  toHaveCount(value: number): Promise<void>;
  toBe(value: unknown): Promise<void>; toEqual(value: unknown): Promise<void>;
  toContain(value: unknown): Promise<void>; toBeTruthy(): Promise<void>; toBeFalsy(): Promise<void>;
};
declare const page: TestLocator;
declare function expect(value: unknown): TestAssertions;
declare const agent: {
  sendMessage(message: string): Promise<void>;
  expectText(text: string): Promise<void>;
  expectAction(actionId: string, input?: Record<string, unknown>): Promise<void>;
  expectHandoff(name: string, expected?: {href?: string; message?: string}): Promise<void>;
};
declare const test: {step<T>(name: string, body: () => Promise<T>): Promise<T>};
`
