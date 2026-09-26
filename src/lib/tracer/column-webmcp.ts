import { z } from "zod"
import type { ComputedColumnStore } from "./computed-column-store"
import type { ComputedColumn } from "./computed-columns"
import { resolveLogColumnOrder, type EvalColumnLayout } from "./log-column-order"

export type PageTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean }
  execute: (
    input: unknown,
    options?: { signal?: AbortSignal }
  ) => Promise<{
    content: { type: "text"; text: string }[]
    structuredContent?: Record<string, unknown>
    isError?: boolean
  }>
}

const runId = z
  .string()
  .min(1)
  .max(128)
  .describe(
    "The table scope ID, returned by list_eval_columns (eval run, playground app, dataset, agents, or workflows). Must match the current table."
  )
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/)
  .describe("Stable computed column ID.")
const name = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .describe("Display name of the column.")
const code = z
  .string()
  .min(1)
  .max(16000)
  .refine((value) => !!value.trim(), "Code must not be blank")
  .describe(
    "JavaScript expression, or text containing {{ JavaScript }} in template mode. Example: R${{row.metrics.cost*5.5}}. Code runs per row in the existing browser worker; errors appear in cells."
  )
const mode = z
  .enum(["expression", "template"])
  .describe(
    "expression evaluates JavaScript directly; template interpolates {{ JavaScript }} into text."
  )
const format = z.enum(["text", "markdown"]).optional()
const fields = { name, code, mode, format }
const scope = z.strictObject({ runId })
const target = scope.extend({ id })
const create = scope.extend({
  ...fields,
  id: id
    .optional()
    .describe(
      "Optional client-generated ID for safe retries. Omit to generate a UUID."
    ),
})
const update = target
  .extend({
    name: name.optional(),
    code: code.optional(),
    mode: mode.optional(),
    format,
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.code !== undefined ||
      value.mode !== undefined || value.format !== undefined,
    "Provide at least one of name, code, or mode"
  )

export function createColumnTools(store: ComputedColumnStore, layout?: EvalColumnLayout): PageTool[] {
  function tool<T extends z.ZodType>(
    name: string,
    description: string,
    schema: T,
    readOnly: boolean,
    execute: (args: z.output<T>) => Record<string, unknown> | Promise<Record<string, unknown>>
  ): PageTool {
    return {
      name,
      description,
      inputSchema: z.toJSONSchema(schema),
      annotations: { readOnlyHint: readOnly, untrustedContentHint: true },
      async execute(input, options) {
        try {
          options?.signal?.throwIfAborted()
          const args = schema.parse(input)
          const snapshot = store.getSnapshot()
          if (!snapshot.loaded)
            throw new Error(
              snapshot.storageError ??
                "Columns are still loading. Try again after the eval run loads."
            )
          if (
            args &&
            typeof args === "object" &&
            "runId" in args &&
            args.runId !== store.runId
          )
            throw new Error(
              `Wrong eval run. This page is ${store.runId}. Call list_eval_columns to refresh context.`
            )
          const result = {
            runId: store.runId,
            storage: "global definitions; browser-local selection",
            ...await execute(args),
          }
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          }
        } catch (error) {
          const message =
            error instanceof z.ZodError
              ? error.issues
                  .map(
                    (issue) =>
                      `${issue.path.join(".") || "input"}: ${issue.message}`
                  )
                  .join("; ")
              : error instanceof Error
                ? error.message
                : "Column operation failed."
          return { isError: true, content: [{ type: "text", text: message }] }
        }
      },
    }
  }
  const find = (id: string) => {
    const column = store
      .getSnapshot()
      .columns.find((column) => column.id === id)
    if (!column)
      throw new Error(
        `Computed column ${id} was not found. Call list_eval_columns for current IDs.`
      )
    return column
  }
  const columnId = z.string().min(1).max(256).describe("Table column ID from get_eval_column_order, including built-in IDs and computed:<id>.")
  const readOrder = () => {
    if (!layout) throw new Error("Column ordering is unavailable on this page.")
    const definitions = layout.getColumns()
    const order = resolveLogColumnOrder(definitions.map(column => column.id), layout.order.getSnapshot())
    return {
      order,
      columns: order.map(id => ({ id, name: definitions.find(column => column.id === id)!.name })),
      fixedLeading: ["__select"],
      fixedTrailing: ["add-column"],
    }
  }
  const saveOrder = (next: string[]) => {
    const previousOrder = readOrder().order
    if (next.length !== previousOrder.length || new Set(next).size !== next.length || next.some(id => !previousOrder.includes(id))) {
      throw new Error("Provide each current movable column ID exactly once. Call get_eval_column_order for current IDs. Selection and Add Column stay fixed and must be excluded.")
    }
    layout!.order.set(next, true)
    return { ...readOrder(), previousOrder, persisted: true }
  }
  return [
    tool(
      "list_eval_columns",
      "List all computed column definitions and the current table scope ID. These are selected global fields on the active log table; built-in columns are excluded. Use the returned runId for other column tools.",
      z.strictObject({}),
      true,
      () => ({ columns: store.getSnapshot().columns })
    ),
    tool(
      "get_eval_column",
      "Read one computed column definition (id, name, code, mode) on the active log table.",
      target,
      true,
      (args) => ({ column: find(args.id) })
    ),
    tool(
      "create_eval_column",
      "Create and persist a read-only computed column on the active log table. Dataset rows expose row.input, row.expectedOutput, and row.metadata. Eval and trace rows also expose row.output, row.results, row.trace, and row.metrics.cost (USD). Agent and workflow rows aggregate across versions by name and expose row.name, row.groupType, and row.metrics aggregates such as versionCount, count, completedCount, meanDurationMs, and reportedCostUsd (nullable). The table evaluates the column per row without changing source data. Reusing an explicit ID with the same definition is a no-op; a conflicting definition is an error.",
      create,
      false,
      async (args) => {
        const column: ComputedColumn = {
          id: args.id ?? crypto.randomUUID(),
          name: args.name,
          code: args.code,
          mode: args.mode,
          format: args.format,
        }
        const existing = store
          .getSnapshot()
          .columns.find((current) => current.id === column.id)
        if (existing) {
          if (
            existing.name !== column.name ||
            existing.code !== column.code ||
            existing.mode !== column.mode || (existing.format ?? "text") !== (column.format ?? "text")
          )
            throw new Error(
              `Column ID ${column.id} already exists with a different definition. Use update_eval_column.`
            )
          return { column: existing, created: false }
        }
        await store.update((current) => [...current, column], true)
        return { column: store.getSnapshot().columns.find(item => item.id === column.id) ?? store.getSnapshot().columns.find(item => item.name === column.name), created: true, persisted: true }
      }
    ),
    tool(
      "update_eval_column",
      "Update a computed column's name, code, mode, and/or display format, preserving its ID, position, and unspecified fields. Updates the global field definition and the table.",
      update,
      false,
      async (args) => {
        const existing = find(args.id)
        const column = {
          ...existing,
          ...Object.fromEntries(
            Object.entries({
              name: args.name,
              code: args.code,
              mode: args.mode,
              format: args.format,
            }).filter(([, value]) => value !== undefined)
          ),
        }
        await store.update(
          (current) =>
            current.map((item) => (item.id === column.id ? column : item)),
          true
        )
        return { column, persisted: true }
      }
    ),
    tool(
      "delete_eval_column",
      "Delete one computed column from this eval run's browser-local saved columns and table. Returns its prior definition for recreation. Repeating deletion of an absent ID is a no-op. Does not delete traces, eval results, or built-in columns.",
      target,
      false,
      async (args) => {
        const column = store
          .getSnapshot()
          .columns.find((item) => item.id === args.id)
        if (!column) return { id: args.id, deleted: false }
        await store.update(
          (current) => current.filter((item) => item.id !== args.id),
          true
        )
        return { column, deleted: true, persisted: true }
      }
    ),
    ...(layout ? [
      tool("get_eval_column_order", "Read the current table column order and ID/name catalog, including built-in and computed columns. Includes hidden columns; does not change visibility. Selection stays first and Add Column stays last, outside the reorderable list.", scope, true, readOrder),
      tool("reorder_eval_columns", "Set the complete table column order. Pass every ID from get_eval_column_order exactly once. Immediately updates the table and persists in this browser for this run; returns previousOrder for undo.", scope.extend({ columnIds: z.array(columnId) }), false, args => saveOrder(args.columnIds)),
      tool("move_eval_column", "Move a built-in or computed column before or after another column without changing other columns' relative order. Use IDs from get_eval_column_order and exactly one of beforeColumnId or afterColumnId.", scope.extend({
        columnId,
        beforeColumnId: columnId.optional(),
        afterColumnId: columnId.optional(),
      }).refine(args => (args.beforeColumnId !== undefined) !== (args.afterColumnId !== undefined), "Provide exactly one of beforeColumnId or afterColumnId"), false, args => {
        const order = readOrder().order
        const anchor = args.beforeColumnId ?? args.afterColumnId!
        if (!order.includes(args.columnId) || !order.includes(anchor)) throw new Error("Unknown or fixed column. Call get_eval_column_order for movable IDs.")
        if (args.columnId === anchor) return saveOrder(order)
        const next = order.filter(id => id !== args.columnId)
        next.splice(next.indexOf(anchor) + (args.afterColumnId !== undefined ? 1 : 0), 0, args.columnId)
        return saveOrder(next)
      }),
      tool("swap_eval_columns", "Swap the positions of two built-in or computed columns, leaving all other columns in place. Use IDs from get_eval_column_order. Immediately updates the table and persists in this browser.", scope.extend({ firstColumnId: columnId, secondColumnId: columnId }), false, args => {
        const next = readOrder().order
        const first = next.indexOf(args.firstColumnId)
        const second = next.indexOf(args.secondColumnId)
        if (first < 0 || second < 0) throw new Error("Unknown or fixed column. Call get_eval_column_order for movable IDs.")
        ;[next[first], next[second]] = [next[second], next[first]]
        return saveOrder(next)
      }),
    ] : []),
  ]
}

/** Small feature-detected boundary for the current draft and earlier browsers. */
export type PageModelContext = {
  registerTool: (
    tool: PageTool,
    options?: { signal: AbortSignal }
  ) => void | Promise<void>
  unregisterTool?: (name: string) => void
}

export function registerColumnTools(
  context: PageModelContext,
  tools: PageTool[],
  onError: (error: unknown) => void
) {
  const controller = new AbortController()
  const registered = new Set<string>()
  const dispose = () => {
    controller.abort()
    // Legacy implementations use synchronous unregisterTool; modern ones use the signal.
    if (context.unregisterTool)
      for (const name of registered) context.unregisterTool(name)
    registered.clear()
  }
  for (const tool of tools) {
    if (controller.signal.aborted) break
    try {
      const registration = context.registerTool(
        {
          ...tool,
          execute: async (input, options) => {
            if (controller.signal.aborted)
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: "This eval page is no longer active. Refresh the available tools.",
                  },
                ],
              }
            return tool.execute(input, options)
          },
        },
        { signal: controller.signal }
      )
      if (!registration) registered.add(tool.name)
      else
        void registration.catch((error) => {
          if (!controller.signal.aborted) {
            dispose()
            onError(error)
          }
        })
    } catch (error) {
      dispose()
      onError(error)
    }
  }
  return dispose
}
