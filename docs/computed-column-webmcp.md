# Computed columns over WebMCP

Open `/evals/<runId>` in a WebMCP-capable browser and wait for the run to load. The page registers these tools:

| Tool                 | Input                                                | Result                                                    |
| -------------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| `list_eval_columns`  | `{}`                                                 | Current `runId` and all computed column definitions       |
| `get_eval_column`    | `runId`, `id`                                        | One column definition                                     |
| `create_eval_column` | `runId`, `name`, `code`, `mode`, optional `id`       | Created column and persistence result                     |
| `update_eval_column` | `runId`, `id`, one or more of `name`, `code`, `mode` | Updated definition; unspecified fields are preserved      |
| `delete_eval_column` | `runId`, `id`                                        | Deleted definition, or `deleted: false` if already absent |
| `get_eval_column_order` | `runId` | Current order and ID/name catalog for built-in and computed columns |
| `move_eval_column` | `runId`, `columnId`, exactly one of `beforeColumnId` or `afterColumnId` | Move one column relative to another |
| `swap_eval_columns` | `runId`, `firstColumnId`, `secondColumnId` | Exchange two columns' positions |
| `reorder_eval_columns` | `runId`, `columnIds` | Set the complete order using every movable ID exactly once |

For example, call `list_eval_columns` to get the run ID, then pass this to `create_eval_column`:

```json
{
  "runId": "<runId returned by list_eval_columns>",
  "id": "cost-brl",
  "name": "Cost (BRL)",
  "mode": "template",
  "code": "R${{(row.metrics.cost * 5.5).toFixed(4)}}"
}
```

Use `mode: "expression"` for plain JavaScript such as `row.metrics.totalTokens`. The same worker, row context, error display, and Monaco editor apply to columns created through either interface. Formula errors are displayed in cells; creating a definition does not assert the formula succeeds on every row.

Columns and their order remain local to this browser and eval run. Tool writes update the visible table and local storage together; storage failures return `isError` without applying the mutation. Inputs are validated, wrong-run calls fail, and explicit create IDs support retries: an identical definition is a no-op, while a conflicting definition fails. Deleting a column returns its definition so it can be recreated. Built-in column definitions, traces, and eval results are outside these tools' scope.

Ordering tools share the same state as dragging labels in the table. Read `get_eval_column_order` first: IDs such as `input`, `score:<evaluatorId>`, and `computed:<columnId>` differ from the plain computed IDs used by the CRUD tools. Hidden columns are included in the order; ordering does not change visibility. The selection control stays first and **+ Add Column** stays last, outside the movable list. Mutations return `previousOrder`, which can be passed to `reorder_eval_columns` to undo. Full-order updates reject missing, duplicate, stale, or fixed IDs. Swaps exchange positions each time they execute; prefer a move or full-order update when retrying an uncertain request.

For example, move the reasoning column next to its score:

```json
{
  "runId": "<runId>",
  "columnId": "computed:factuality-reasoning",
  "afterColumnId": "score:<Factuality evaluator ID>"
}
```

Pass this to `move_eval_column`, using IDs returned by `get_eval_column_order`.

The integration feature-detects the [WebMCP draft's `document.modelContext`](https://webmachinelearning.github.io/webmcp/) and falls back to `navigator.modelContext` in older implementations. Registrations are removed when leaving the eval detail page using abort signals or legacy `unregisterTool`. Browsers without WebMCP retain the regular column UI; no fake browser API or remote MCP server is installed.

Validation: `bun test tests/column-webmcp.test.ts tests/column-order-webmcp.test.ts tests/collection-column-order.test.ts`.
