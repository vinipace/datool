import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { Frame, FrameLocator, Locator, Page } from "playwright"
import type { JourneyResult } from "@/src/lib/build/agent-journey"

const selectorMethods = [
  "getByRole",
  "getByLabel",
  "getByText",
  "getByPlaceholder",
  "getByTestId",
  "locator",
  "first",
  "last",
  "nth",
] as const
const locatorMethods = [
  "click",
  "fill",
  "selectOption",
  "setChecked",
  "check",
  "uncheck",
  "getAttribute",
  "innerText",
  "textContent",
  "inputValue",
  "count",
  "isVisible",
  "isEnabled",
  "isChecked",
] as const
const matcherMethods = [
  "toBeVisible",
  "toBeHidden",
  "toBeEnabled",
  "toBeDisabled",
  "toBeChecked",
  "toHaveText",
  "toContainText",
  "toHaveValue",
  "toHaveAttribute",
  "toHaveCount",
  "toBe",
  "toEqual",
  "toContain",
  "toBeTruthy",
  "toBeFalsy",
] as const
const commandSchema = z
  .object({
    kind: z.enum(["locator", "assert", "value", "agent"]),
    method: z.string().max(50),
    target: z
      .array(
        z
          .object({
            method: z.enum(selectorMethods),
            args: z.array(z.json()).max(2),
          })
          .strict()
      )
      .min(1)
      .max(12)
      .optional(),
    args: z.array(z.json()).max(2).default([]),
    value: z.json().optional(),
    negate: z.boolean().default(false),
    label: z.string().max(300).optional(),
  })
  .strict()

export type JourneyCodeHooks = {
  afterAction: () => Promise<void>
  agent: (method: string, args: unknown[]) => Promise<void>
  record: (step: JourneyResult["steps"][number]) => void
}

/** User JavaScript runs in an opaque Chromium frame, never in the Node process. */
export async function runJourneyCode(
  page: Page,
  scope: () => FrameLocator | Page,
  code: string,
  signal: AbortSignal,
  hooks: JourneyCodeHooks,
  timeoutMs = 30_000
) {
  const { expect } = await import("playwright/test")
  const binding = `journey_${randomUUID().replaceAll("-", "")}`
  let runner: Frame | null = null
  let operations = 0
  let assertions = 0
  let firstError: Error | undefined
  let pending = Promise.resolve<unknown>(undefined)
  const resolve = (
    target: z.infer<typeof commandSchema>["target"]
  ): Locator => {
    if (!target) throw new Error("A browser locator is required.")
    let locator: Locator | undefined
    for (const part of target) {
      const root = locator ?? scope()
      const [value, options] = part.args
      switch (part.method) {
        case "getByRole":
          locator = root.getByRole(
            z.string().parse(value) as Parameters<Page["getByRole"]>[0],
            z
              .object({
                name: z.string().max(300).optional(),
                exact: z.boolean().optional(),
              })
              .strict()
              .optional()
              .parse(options)
          )
          break
        case "getByLabel":
        case "getByText":
        case "getByPlaceholder":
          locator = root[part.method](
            z.string().max(4000).parse(value),
            z
              .object({ exact: z.boolean().optional() })
              .strict()
              .optional()
              .parse(options)
          )
          break
        case "getByTestId":
        case "locator":
          locator = root[part.method](z.string().max(1000).parse(value))
          break
        case "first":
        case "last":
          if (!locator) throw new Error("Choose a locator first.")
          locator = locator[part.method]()
          break
        case "nth":
          if (!locator) throw new Error("Choose a locator first.")
          locator = locator.nth(z.number().int().min(0).max(1000).parse(value))
          break
      }
    }
    return locator!
  }
  await page.exposeBinding(binding, (source, raw: string) => {
    if (source.frame !== runner)
      throw new Error("Test commands must originate from the test frame.")
    if (++operations > 160 || typeof raw !== "string" || raw.length > 64_000) {
      firstError ??= new Error(
        operations > 160
          ? "A test can execute at most 160 browser operations."
          : "Test command is too large."
      )
      // Stop an unawaited command flood before allocating another queued task.
      void page
        .context()
        .close()
        .catch(() => {})
      throw firstError
    }
    const operation = pending.then(async () => {
      signal.throwIfAborted()
      const command = commandSchema.parse(JSON.parse(raw))
      const description =
        `${command.label ? command.label + ": " : ""}${command.method} ${
          command.target
            ?.map((part) => {
              const options = part.args[1]
              const name =
                options &&
                typeof options === "object" &&
                !Array.isArray(options)
                  ? options.name
                  : undefined
              return [part.args[0] ?? part.method, name]
                .filter((value) => value !== undefined)
                .join(" ")
            })
            .join(" / ") ??
          (command.kind === "agent" ? (command.args[0] ?? "") : "")
        }`.trim()
      try {
        let result: unknown
        if (command.kind === "agent") {
          if (
            ![
              "sendMessage",
              "expectText",
              "expectAction",
              "expectHandoff",
            ].includes(command.method)
          )
            throw new Error("Unsupported agent method.")
          await hooks.agent(command.method, command.args)
          if (command.method !== "sendMessage") assertions++
        } else if (command.kind === "assert" || command.kind === "value") {
          const matcher = z.enum(matcherMethods).parse(command.method)
          const locatorAssertion = command.kind === "assert"
          if (
            locatorAssertion ===
            [
              "toBe",
              "toEqual",
              "toContain",
              "toBeTruthy",
              "toBeFalsy",
            ].includes(matcher)
          )
            throw new Error("This assertion does not match its target.")
          const target = locatorAssertion
            ? resolve(command.target)
            : command.value
          const base = expect(target)
          const assertion = (command.negate
            ? base.not
            : base) as unknown as Record<
            string,
            (...args: unknown[]) => Promise<void>
          >
          await assertion[matcher](
            ...command.args,
            ...(locatorAssertion ? [{ timeout: 4000 }] : [])
          )
          assertions++
        } else {
          const method = z.enum(locatorMethods).parse(command.method)
          const locator = resolve(command.target)
          switch (method) {
            case "click":
              // Inspect handoff destinations without opening a live external chat.
              if (
                !(await locator.evaluate((element) => element.tagName === "A"))
              )
                await locator.click()
              break
            case "fill":
            case "selectOption":
              result = await locator[method](
                z.string().max(4000).parse(command.args[0])
              )
              break
            case "setChecked":
              await locator.setChecked(z.boolean().parse(command.args[0]))
              break
            case "getAttribute":
              result = await locator.getAttribute(
                z.string().max(120).parse(command.args[0])
              )
              break
            default:
              result = await locator[method]()
              break
          }
          if (
            [
              "click",
              "fill",
              "selectOption",
              "setChecked",
              "check",
              "uncheck",
            ].includes(method)
          )
            await hooks.afterAction()
        }
        hooks.record({ name: description, status: "passed", error: null })
        return result === undefined ? null : result
      } catch (error) {
        firstError ??= new Error(String(error).slice(0, 2000))
        hooks.record({
          name: description,
          status: "failed",
          error: firstError.message,
        })
        throw firstError
      }
    })
    pending = operation.catch((error) => {
      firstError ??= new Error(String(error).slice(0, 2000))
    })
    return operation
  })
  await page.evaluate(() => {
    document
      .querySelectorAll('iframe[title="Test code"]')
      .forEach((frame) => frame.remove())
    const iframe = document.createElement("iframe")
    iframe.title = "Test code"
    iframe.hidden = true
    iframe.setAttribute("sandbox", "allow-scripts")
    iframe.srcdoc = "<!doctype html><html><body></body></html>"
    document.body.append(iframe)
  })
  runner = await (await page
    .locator('iframe[title="Test code"]')
    .elementHandle())!.contentFrame()
  if (!runner) throw new Error("The test code frame could not start.")
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: () => void = () => {}
  try {
    const program = runner.evaluate(
      async ({
        code,
        binding,
        selectorMethods,
        locatorMethods,
        matcherMethods,
      }) => {
        const invoke = (
          window as unknown as Record<
            string,
            (value: string) => Promise<unknown>
          >
        )[binding]
        let label: string | undefined
        const call = (command: Record<string, unknown>) =>
          invoke(JSON.stringify({ ...command, label }))
        const locators = new WeakMap<object, unknown[]>()
        const locate = (target: unknown[] = []) => {
          const result: Record<string, unknown> = {}
          for (const method of selectorMethods)
            result[method] = (...args: unknown[]) =>
              locate([...target, { method, args }])
          for (const method of locatorMethods)
            result[method] = (...args: unknown[]) =>
              call({ kind: "locator", method, args, target })
          locators.set(result, target)
          return result
        }
        const expect = (
          value: unknown,
          negate = false
        ): Record<string, unknown> => {
          const target =
            value && typeof value === "object" ? locators.get(value) : undefined
          const result: Record<string, unknown> = {}
          Object.defineProperty(result, "not", {
            get: () => expect(value, !negate),
          })
          for (const method of matcherMethods)
            result[method] = (...args: unknown[]) =>
              call({
                kind: target ? "assert" : "value",
                method,
                args,
                negate,
                ...(target ? { target } : { value }),
              })
          return result
        }
        const agent = Object.fromEntries(
          ["sendMessage", "expectText", "expectAction", "expectHandoff"].map(
            (method) => [
              method,
              (...args: unknown[]) => call({ kind: "agent", method, args }),
            ]
          )
        )
        const test = {
          step: async (name: string, body: () => Promise<unknown>) => {
            const previous = label
            label = name
            try {
              return await body()
            } finally {
              label = previous
            }
          },
        }
        const AsyncFunction = Object.getPrototypeOf(
          async function () {}
        ).constructor
        await new AsyncFunction(
          "page",
          "expect",
          "agent",
          "test",
          '"use strict";\n' + code + "\n//# sourceURL=agent-test.js"
        )(locate(), expect, agent, test)
      },
      {
        code,
        binding,
        selectorMethods: [...selectorMethods],
        locatorMethods: [...locatorMethods],
        matcherMethods: [...matcherMethods],
      }
    )
    await Promise.race([
      program
        .catch((error) => {
          throw firstError ?? error
        })
        .then(async () => {
          await pending
          if (firstError) throw firstError
          if (!assertions)
            throw new Error("Add at least one expect assertion to this test.")
        }),
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error("Test cancelled."))
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
        timer = setTimeout(
          () =>
            reject(new Error("Test code exceeded its 30 second time limit.")),
          timeoutMs
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
    // Browser shutdown also terminates a non-yielding script in Chromium.
  }
}
