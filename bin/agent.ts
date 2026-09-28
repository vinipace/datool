import { readFile, stat, open, rename, link, unlink } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { appRequest } from "./request"

export const agentUsage = `Agent workflows (all commands return JSON):
  datool apps list|get|register|run [id]
  datool traces list|get|spans|scores|path|resolve [id] [--filter <expression>]
  datool sessions list|get|resolve [id]
  datool reviews list|get|create|update|options|item|record [sessionId]
  datool reviews export [sessionId] --out <file.ndjson>
  datool human-scores list|get|create|update [id]
  datool review-collections list|get|create|update [id]
  datool scorers libraries|use-library|list|get|create|update|delete|versions|version|test|check|probe|resolve [id]
  datool datasets list|get|create|update|delete|items|add|edit|remove|bulk|promote [id]
  datool datasets snapshot|snapshots|version|resolve [id]
  datool evals list|groups|get|target|run|rescore|compare|wait|gate|resolve [id]
  datool evals cancel|recover [id]
  datool evals run --parent-run-id <id> [--use-recorded-versions]
  datool evals target <run-id> --target-id <row-id>
  datool metrics metadata|query|batch
  datool dashboards list|get|create|update|delete|preview|resolve [id]
  datool views list|get|data|resolve [id]
  datool page-views list|get|create|update|copy|delete|history|restore|dependencies|validate|data|resolve [id]
  datool custom-fields list|get|create|update|copy|delete|history|restore|dependencies|validate|evaluate [id]
  datool object-views list|get|create|update|copy|delete|history|restore|dependencies|validate|preview [id]
  datool view-preferences get|save --scope <page/context>
  datool traces|sessions|datasets|evals export [id] --out <file.ndjson>
  datool agent tools [operation]
  datool agent call <operation> --input <json|@file|->

Input: --input <json|@file|->; scalar --kebab-case flags map to camelCase.
Pagination: --limit 1..100 --cursor <cursor> --include-total
Eval reads: lightweight by default; --include-evidence embeds full case evidence.
Follow nextCursor/nextOffset; batches may shrink to fit the response size limit.
Evaluation: --request-key <stable-key> --wait --timeout 300 --poll-interval 2
CI gate: --min-score 0.8 --min-pass-rate 1 --baseline-id <id> --max-regression 0
Exit codes: 0 success, 1 request/usage error, 2 failed CI gate, 3 wait timeout.
Exports: --max-rows 10000 --replace; continuation metadata goes to stderr.
Use agent tools <operation> to inspect the exact input schema and permissions.`

const aliases: Record<string, string> = {
  "apps.list": "list_apps",
  "apps.get": "get_app",
  "apps.register": "register_app",
  "apps.run": "run_app",
  "traces.list": "list_traces",
  "traces.get": "get_trace",
  "traces.spans": "list_trace_spans",
  "traces.scores": "list_trace_scores",
  "traces.path": "get_span_path",
  "sessions.list": "list_sessions",
  "sessions.get": "get_session",
  "reviews.list": "list_review_sessions",
  "reviews.get": "get_review_session",
  "reviews.create": "create_review_session",
  "reviews.update": "update_review_session",
  "reviews.options": "get_review_options",
  "reviews.item": "get_review_item",
  "reviews.record": "record_review",
  "human-scores.list": "list_human_scores",
  "human-scores.get": "get_human_score",
  "human-scores.create": "create_human_score",
  "human-scores.update": "update_human_score",
  "review-collections.list": "list_human_scores",
  "review-collections.get": "get_human_score_collection",
  "review-collections.create": "create_human_score_collection",
  "review-collections.update": "update_human_score_collection",
  "scorers.list": "list_scorers",
  "scorers.libraries": "list_scorer_libraries",
  "scorers.use-library": "use_library_scorer",
  "scorers.get": "get_scorer",
  "scorers.create": "create_scorer",
  "scorers.update": "update_scorer",
  "scorers.delete": "delete_scorer",
  "scorers.versions": "list_scorer_versions",
  "scorers.version": "get_scorer_version",
  "scorers.test": "test_scorer",
  "scorers.check": "check_scorer_runtime",
  "scorers.probe": "probe_scorer_runtime",
  "datasets.list": "list_datasets",
  "datasets.get": "get_dataset",
  "datasets.create": "create_dataset",
  "datasets.update": "update_dataset",
  "datasets.delete": "delete_dataset",
  "datasets.items": "list_dataset_items",
  "datasets.add": "create_dataset_item",
  "datasets.edit": "update_dataset_item",
  "datasets.remove": "delete_dataset_item",
  "datasets.bulk": "bulk_dataset_items",
  "datasets.promote": "promote_spans",
  "datasets.snapshot": "create_dataset_snapshot",
  "datasets.snapshots": "list_dataset_snapshots",
  "datasets.version": "get_dataset_snapshot",
  "evals.cancel": "cancel_eval_run",
  "evals.recover": "recover_eval_run",
  "evals.list": "list_eval_runs",
  "evals.groups": "list_eval_run_groups",
  "evals.get": "get_eval_run",
  "evals.target": "get_eval_target",
  "evals.run": "start_eval_run",
  "evals.rescore": "start_eval_run",
  "evals.compare": "compare_eval_runs",
  "evals.gate": "gate_eval_run",
  "evals.wait": "get_eval_run",
  "metrics.metadata": "get_metrics_metadata",
  "metrics.query": "query_metrics",
  "metrics.batch": "batch_metrics",
  "dashboards.list": "list_dashboards",
  "dashboards.get": "get_dashboard",
  "dashboards.create": "create_dashboard",
  "dashboards.update": "update_dashboard",
  "dashboards.delete": "delete_dashboard",
  "dashboards.preview": "preview_dashboard",
  "views.list": "list_saved_views",
  "views.get": "get_saved_view",
  "views.data": "get_saved_view_data",
}
for (const [plural, singular] of Object.entries({
  traces: "trace",
  sessions: "session",
  scorers: "scorer",
  datasets: "dataset",
  evals: "eval",
  dashboards: "dashboard",
  views: "view",
}))
  aliases[`${plural}.resolve`] = `resolve_${singular}`

type Input = Record<string, unknown>
type Call = (
  operation: string,
  input: Input,
  options?: { signal?: AbortSignal }
) => Promise<unknown>
class WaitTimeout extends Error {}
const numeric = new Set([
  "limit",
  "offset",
  "expectedRevision",
  "revision",
  "before",
  "minScore",
  "minPassRate",
  "maxErrors",
  "maxRegression",
  "concurrency",
])
const boolean = new Set([
  "includeTotal",
  "includeEvidence",
  "allowUnscored",
  "useRecordedVersions",
])
const localOptions = new Set([
  "datool",
  "project",
  "input",
  "out",
  "replace",
  "wait",
  "timeout",
  "pollInterval",
  "maxRows",
  "json",
])

async function readInput(raw: string) {
  if (raw === "-") {
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > 1024 * 1024) throw new Error("Input exceeds 1 MiB.")
      chunks.push(buffer)
    }
    return Buffer.concat(chunks).toString("utf8")
  }
  if (raw.startsWith("@")) {
    const path = resolve(raw.slice(1))
    if ((await stat(path)).size > 1024 * 1024)
      throw new Error("Input exceeds 1 MiB.")
    return readFile(path, "utf8")
  }
  return raw
}

export async function waitForEval(
  call: Call,
  id: string,
  timeoutSeconds = 300,
  pollSeconds = 2
) {
  if (
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0 ||
    timeoutSeconds > 86400 ||
    !Number.isFinite(pollSeconds) ||
    pollSeconds < 0.1 ||
    pollSeconds > 60
  )
    throw new Error(
      "Use timeout 1..86400 seconds and poll-interval 0.1..60 seconds."
    )
  const deadline = Date.now() + timeoutSeconds * 1000
  const signal = AbortSignal.timeout(timeoutSeconds * 1000)
  while (true) {
    const run = (await call(
      "get_eval_run",
      { id, limit: 1, includeEvidence: false },
      { signal }
    ).catch((error) => {
      if (signal.aborted)
        throw new WaitTimeout(
          `Stopped waiting for evaluation ${id}; resume with datool evals wait ${id}. The run was not cancelled.`
        )
      throw error
    })) as {
      id: string
      status: string
    }
    if (["completed", "partial", "failed", "cancelled"].includes(run.status))
      return run
    if (run.status !== "running")
      throw new Error("Datool returned an unknown evaluation status.")
    const remaining = deadline - Date.now()
    if (remaining <= 0)
      throw new WaitTimeout(
        `Evaluation ${id} is still running; resume with datool evals wait ${id}.`
      )
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(remaining, pollSeconds * 1000))
    )
  }
}

/** Bounded pages are written before fetching the next; no whole-export buffer. */
export async function exportPages(
  call: Call,
  operation: string,
  input: Input,
  out: string,
  maxRows = 10000,
  replace = false
) {
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 100000)
    throw new Error("max-rows must be 1..100000.")
  const target = resolve(out)
  const temporary = `${target}.${randomUUID()}.tmp`
  const file = await open(temporary, "wx", 0o600)
  let count = 0,
    bytes = 0,
    cursor = input.cursor as string | undefined,
    complete = false
  const seen = new Set<string>()
  try {
    while (count < maxRows) {
      const page = (await call(operation, {
        ...input,
        limit: Math.min(100, maxRows - count),
        ...(cursor ? { cursor } : {}),
      })) as { items?: unknown[]; rows?: unknown[]; nextCursor?: string | null }
      const rows = page.items ?? page.rows
      if (!Array.isArray(rows))
        throw new Error("This operation does not return a pageable collection.")
      if (rows.length > Math.min(100, maxRows - count))
        throw new Error("Datool exceeded the requested export page size.")
      const chunk = rows.map((row) => JSON.stringify(row) + "\n").join("")
      bytes += Buffer.byteLength(chunk)
      if (bytes > 256 * 1024 * 1024)
        throw new Error("Export exceeds 256 MiB; request a narrower filter.")
      await file.writeFile(chunk)
      count += rows.length
      cursor = page.nextCursor ?? undefined
      if (!cursor) {
        complete = true
        break
      }
      if (!rows.length || seen.has(cursor))
        throw new Error("Datool returned a stalled export cursor.")
      seen.add(cursor)
    }
    await file.close()
    if (replace) await rename(temporary, target)
    else {
      await link(temporary, target)
      await unlink(temporary)
    }
    return {
      path: target,
      rows: count,
      bytes,
      complete,
      nextCursor: cursor ?? null,
      operation,
      input,
    }
  } catch (error) {
    await file.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    throw error
  }
}

export async function agentCommand(args: string[]): Promise<number | null> {
  const [group, action] = args
  if (!(
    group === "agent" ||
    group === "metrics" ||
    (group === "apps" && ["list", "get", "register", "run"].includes(action)) ||
    [
      "traces",
      "sessions",
      "reviews",
      "human-scores",
      "review-collections",
      "scorers",
      "datasets",
      "evals",
      "dashboards",
      "views",
      "page-views",
      "custom-fields",
      "object-views",
      "view-preferences",
    ].includes(group)
  ))
    return null
  try {
    const flags: Input = {},
      positional: string[] = []
    for (let i = 2; i < args.length; i++) {
      const token = args[i]
      if (!token.startsWith("--")) {
        positional.push(token)
        continue
      }
      const key = token
        .slice(2)
        .replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())
      const isBoolean =
        boolean.has(key) || ["replace", "wait", "json"].includes(key)
      const raw = args[i + 1]
      if (!isBoolean && (!raw || raw.startsWith("--")))
        throw new Error(`${token} requires a value.`)
      if (isBoolean) {
        flags[key] = raw === "false" ? false : true
        if (raw === "true" || raw === "false") i++
      } else {
        flags[key] = numeric.has(key) ? Number(raw) : raw
        i++
      }
    }
    let input: Input = {}
    if (flags.input) {
      const raw = String(flags.input)
      input = JSON.parse(await readInput(raw))
      if (!input || Array.isArray(input) || typeof input !== "object")
        throw new Error("--input must be a JSON object.")
    }
    for (const [key, value] of Object.entries(flags))
      if (!localOptions.has(key)) input[key] = value
    if (flags.project) process.env.DATOOL_PROJECT_ID = String(flags.project)
    const origin = String(
      flags.datool ??
        process.env.DATOOL_BASE_URL ??
        process.env.DATOOL_URL ??
        "http://127.0.0.1:3000"
    )
    // Explicit read allowlist: generic POST mutations are never transport-retried.
    const retryableReads = new Set([
      "get_eval_run",
      "get_eval_target",
      "list_eval_runs",
      "list_traces",
      "list_sessions",
      "list_dataset_items",
      "list_datasets",
      "get_dataset_snapshot",
      "list_review_sessions",
      "export_review_items",
      "describe_agent_operations",
      "get_metrics_metadata",
      "query_metrics",
      "batch_metrics",
      "preview_dashboard",
    ])
    const call: Call = (operation, value, options) =>
      appRequest(origin, `/api/agent/${encodeURIComponent(operation)}`, value, {
        signal: options?.signal,
        retry: retryableReads.has(operation) ? "read" : undefined,
        // Preview may span several 15-second batches; single metric reads
        // need room for their server deadline plus transport overhead.
        timeoutMs: [
          "run_app",
          "probe_scorer_runtime",
          "test_scorer",
          "preview_dashboard",
        ].includes(operation)
          ? 120_000
          : ["query_metrics", "batch_metrics"].includes(operation)
            ? 20_000
            : 10_000,
      })
    let operation = aliases[`${group}.${action}`]
    const viewFamily = ({ "page-views": "page_view", "custom-fields": "custom_field", "object-views": "object_view" } as Record<string, string>)[group]
    if (viewFamily) {
      operation = action === "list" ? `list_${viewFamily}s`
        : action === "history" || action === "dependencies" ? `get_${viewFamily}_${action}`
        : action === "data" ? "get_page_view_data" : `${action}_${viewFamily}`
    }
    if (group === "view-preferences") operation = action === "get" ? "get_view_preference" : action === "save" ? "save_view_preference" : ""
    if (group === "agent") {
      if (action === "tools") {
        operation = "describe_agent_operations"
        if (positional[0]) input.name = positional[0]
      } else if (action === "call" && positional[0]) operation = positional[0]
      else
        throw new Error(
          "Use datool agent tools [operation] or agent call <operation> --input <json|@file|->."
        )
    } else if (positional.length) {
      if (positional.length > 1)
        throw new Error(
          "Only one positional ID is accepted; use flags or --input for other fields."
        )
      const key =
        group === "reviews" && ["item", "record"].includes(action)
          ? "sessionId"
          : action === "resolve" && !viewFamily
            ? "key"
            : action === "rescore"
              ? "sourceRunId"
              : group === "datasets" &&
                  [
                    "add",
                    "bulk",
                    "promote",
                    "snapshot",
                    "snapshots",
                    "version",
                  ].includes(action)
                ? "datasetId"
                : action === "path"
                  ? "traceId"
                  : "id"
      input[key] = positional[0]
    }
    if (action === "export") {
      operation =
        group === "reviews"
          ? input.id
            ? "export_review_items"
            : "list_review_sessions"
          : group === "datasets"
            ? input.id
              ? "list_dataset_items"
              : "list_datasets"
            : group === "evals"
              ? input.id
                ? "get_eval_run"
                : "list_eval_runs"
              : group === "traces"
                ? "list_traces"
                : group === "sessions"
                  ? "list_sessions"
                  : ""
      if (!operation || !flags.out)
        throw new Error(
          "Export supports reviews, traces, sessions, datasets and evals and requires --out <file.ndjson>."
        )
      const result = await exportPages(
        call,
        operation,
        input,
        String(flags.out),
        Number(flags.maxRows ?? 10000),
        flags.replace === true
      )
      console.error(JSON.stringify(result))
      return 0
    }
    if (!operation)
      throw new Error(`Unknown command: ${group} ${action}. Use --help.`)
    let result: unknown
    if (group === "evals" && action === "wait") {
      if (typeof input.id !== "string")
        throw new Error("evals wait requires a run ID.")
      result = await waitForEval(
        call,
        input.id,
        Number(flags.timeout ?? 300),
        Number(flags.pollInterval ?? 2)
      )
    } else {
      if (flags.wait && operation === "gate_eval_run")
        await waitForEval(
          call,
          String(input.id ?? ""),
          Number(flags.timeout ?? 300),
          Number(flags.pollInterval ?? 2)
        )
      result = await call(operation, input)
      if (operation === "start_eval_run")
        console.error(
          `Saved evaluation: ${(result as { url?: string; id: string }).url ?? (result as { id: string }).id}`
        )
      if (
        flags.wait &&
        ["start_eval_run", "recover_eval_run"].includes(operation)
      )
        result = await waitForEval(
          call,
          (result as { id: string }).id,
          Number(flags.timeout ?? 300),
          Number(flags.pollInterval ?? 2)
        )
    }
    console.info(JSON.stringify(result, null, 2))
    return operation === "gate_eval_run" &&
      (result as { passed?: boolean }).passed !== true
      ? 2
      : 0
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Datool command failed."
    )
    return error instanceof WaitTimeout ? 3 : 1
  }
}
