# Local JavaScript and Python evaluators

Datool v1 stores JavaScript evaluator code with its versions and runs it only from the local backend. An evaluator receives a serialized trace and an optional dataset item, then returns a finite score from `0` to `1`.

Use plain JavaScript. Define a global `evaluate` function; do not use `export`, `import`, TypeScript syntax, CommonJS, or a module wrapper.

```js
function evaluate({ trace, datasetItem }) {
  const expected = datasetItem?.expectedOutput?.mustInclude
  const answer = trace.output?.answer?.text ?? ""
  const passed = typeof expected === "string" && answer.includes(expected)

  return {
    score: passed ? 1 : 0,
    passed,
    label: "required phrase",
    reason: passed ? "Expected phrase found" : "Expected phrase missing",
    metrics: { answerLength: answer.length },
  }
}
```

The return contract is:

```ts
{
  score: number // finite and inclusive from 0 to 1
  passed?: boolean
  label?: string
  reason?: string
  metrics?: Record<string, JsonValue>
}
```

`reason` becomes the persisted result reasoning. `label` and `metrics` are stored under result metadata, so an eval-results saved view can select `result.metadata.label` or `result.metadata.metrics.answerLength`. A view can combine those with a narrow trace slice such as `trace.output.answer.text`, without selecting the full trace output. An evaluator that does not provide `passed` leaves it null; Datool does not invent a pass threshold from its score.

The evaluator result uses a strict top-level allowlist: `score`, `passed`, `label`, `reason`, and `metrics`. A typo such as `reasoning` is a validation error, rather than a field that silently disappears. Put any additional custom values inside `metrics`.

## Execution boundary

The backend calls:

```ts
import { runEvaluator } from "@/src/server/sandbox/evaluator"

const result = await runEvaluator({
  code: evaluatorVersion.code,
  datasetItem,
  timeoutMs: 1_000,
  trace,
})
```

Each evaluation gets a fresh Node.js subprocess with an empty environment. The subprocess starts Node’s Permission Model, allows read access only to the evaluator worker entrypoint, and does not grant child process, worker thread, addon, or WASI permissions. The evaluator function itself runs in a separate VM context and receives its inputs through JSON parsed inside that context. It does not receive host functions or host objects.

The evaluator context has no exposed `process`, `require`, `module`, `Buffer`, `fetch`, `WebSocket`, `XMLHttpRequest`, timers, or console. Dynamic module imports have no VM import callback. String and WebAssembly code generation are disabled. These restrictions support routine local evaluator mistakes and keep the evaluator from accessing application secrets through the supported API surface.

| Limit                      | V1 value                           |
| -------------------------- | ---------------------------------- |
| Supported runtime          | Node.js 22.13+ with `--permission` |
| Verified local runtime     | Node.js 24.18.0                    |
| Default wall-clock timeout | 1 second                           |
| Caller timeout range       | 10 ms to 5 seconds                 |
| Process memory cap         | 32 MB V8 old space                 |
| Evaluator code             | 128 KB                             |
| Trace/dataset request      | 1 MB                               |
| Evaluator JSON result      | 16 KB                              |
| Child stdout and stderr    | 32 KB combined                     |

The parent process independently kills the child after the wall-clock deadline, so a synchronous loop and an unresolved async promise both fail closed. A syntax error, thrown error, invalid result, out-of-range score, serialization failure, or timeout returns a null score and pass value with a typed error. The evaluation service persists runner errors as `EvalResult.status: "error"`; explicit `passed: true` and `false` become `passed` and `failed`; a valid score with no pass flag is recorded as `completed` without a score threshold.

## Trusted-local v1 only

This is a local developer workflow, not a multi-tenant remote-code sandbox. Node’s own documentation says the [`node:vm` module is not a security mechanism](https://nodejs.org/api/vm.html), so Datool must never advertise this design as safe for arbitrary or hostile code. The isolated subprocess and VM reduce ambient application access and make failures bounded, but v1 accepts only code written by trusted local users.

Node’s [Permission Model](https://nodejs.org/api/permissions.html) is the process-level guard used here. The current verified Node 24.18 runtime restricts filesystem and process-related capabilities used by this worker. It does not expose a network-permission flag in that runtime, so Datool makes no claim of OS-level network isolation. Network APIs are absent from the evaluator context, but an untrusted-code service needs a separately designed OS/container sandbox before it can be offered.

Keep evaluator code free of credentials and do not treat an evaluator’s metadata as an execution capability. The evaluator editor should say: “JavaScript only: define `function evaluate({ trace, datasetItem }) { ... }`. It runs locally with a short timeout; v1 is for trusted local code.”

## Python scorers

Choose **Python** in the scorer editor. Python uses dictionary values and the same
serialized trace/dataset fields as JavaScript:

```python
def evaluate(trace, dataset_item=None):
    expected = (dataset_item or {}).get("expectedOutput")
    matches = trace.get("output") == expected
    return {"score": 1 if matches else 0, "passed": matches}
```

The function must be synchronous and return the same JSON result contract above.
Use `reason` for reasoning, and `metadata` or `metrics` for custom values. Boolean
scores become 0 or 1. Thresholds apply identically to Python and JavaScript.
Python code is persisted in immutable evaluator versions with `language: "python"`;
test previews and background evaluations both use that version's runtime.

Python 3.9+ is required on the server (included in the runtime Docker image).
Set `DATOOL_SANDBOX_PYTHON_BINARY` to an absolute interpreter path if automatic
`python3` discovery is unsuitable. No Python packages are installed per scorer.
Supported imports are `collections`, `datetime`, `decimal`, `fractions`, `functools`,
`itertools`, `json`, `math`, `re`, `statistics`, and `string`.

Each run starts a fresh Python process with an empty environment and `-I -S -B`.
The parent enforces the same 1-second default/5-second maximum wall time and 32 KB
combined output limit as JavaScript. Results are limited to 16 KB. Linux also
limits address space to 128 MB; macOS does not enforce that memory cap. `print`
output is routed to stderr so it does not corrupt the result protocol.

Python shares the trusted-local restriction described above. Restricted imports,
builtins, and audit checks reduce accidental file/network/process access, but are
not a security boundary for hostile code. Python itself documents that
[audit hooks are not suitable as a sandbox](https://docs.python.org/3/library/sys.html#sys.addaudithook).

### Local scorer drafts

Scorer editor changes are stored in this browser's local storage, separately for
each organization, project, and scorer (including the new-scorer form). A yellow
dot after the title marks unsaved edits. The icon-only Save button and `⌘S`
publish the draft in place; the shortcut also works inside the code editor.
Saving keeps the editor and test results open. A new scorer gets its saved URL
without reloading. Successful saves clear the local draft, while failures preserve it. Restored edits keep the
revision they started from so they cannot silently overwrite newer server edits.
Local drafts may be incomplete; normal scorer validation still applies on Save.

## Scorer execution spans

Every evaluation attempt against a recorded trace appends a fresh `score` span
with the scorer icon. This includes editor previews, successful runs, runtime
failures, and reruns. The span starts as running and finishes with its duration,
status, frozen trace and dataset input, scorer definition/version, full result,
and error details. LLM spans also include the rendered judge messages and the
available provider/model, usage, and pricing metadata. Provider credentials are
not copied into spans. An app failure that prevents scoring is recorded with
`scorer.skipped` and its source error.

Results reference their span through `metadata.scorerSpanId`. The live trace
retains all attempts; an eval's inspector attaches only that run and target's
execution spans to its frozen evidence. Datool-generated execution spans are
excluded from future scorer inputs, including linked traces, so repeated
scoring does not evaluate its own history. Original trace timing and status
remain unchanged. Preview `persisted: false` means no evaluation score was
saved; its execution span is still retained. Ad-hoc JSON samples have no recorded
trace to append to. Historical runs are not backfilled with invented spans.
