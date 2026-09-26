# Named agent and workflow performance

Open `/agents` or `/workflows` to compare grouped operations over the last 24 hours, 7, 30, or 90 days. Search by name, sort by volume/error rate/latency/cost, and select a name to inspect its operations. Operation links open the original trace and selected span. Metrics refresh every 15 seconds and export through the page menu.

## Instrumentation

Names are case-sensitive identities, shared across runs. Changing a name starts a different group. No separate registration step is required.

```ts
import { createTracer } from "@/src/lib/tracer/sdk"

const tracer = createTracer()

await tracer.workflow({ name: "Customer onboarding" }, async (workflow) => {
  return workflow.agent({ name: "Account reviewer" }, async (agent) => {
    const result = await reviewAccount()
    await agent.recordCost(result.costUsd)
    return result.output
  })
})
```

`tracer.workflow` starts a named root trace. `workflow.agent` and `workflow.workflow` record named spans inside a trace. `tracer.agent` records a span inside the current async trace context and inherits its active parent span. These callbacks record completion and propagate errors after recording the errored invocation.

`recordCost(usd)` accepts a finite nonnegative number and reports an inclusive USD total without ending the invocation. It replaces the previous reported total; it does not increment it. You can call it on an LLM span, agent span, workflow span, or trace. Preserve actual provider-reported costs; do not send a guessed zero for unavailable pricing. An actual zero is supported. SDK end/error updates preserve the handle's name and cost attributes.

For direct API instrumentation, send `group: { type: "agent", name: "Account reviewer", version: "v1" }` on a trace or span. A workflow uses type `workflow`. Membership is independent of span `kind` and trace `operation`: an LLM, task or function can belong to either group. Group identity is immutable; omit version for an explicitly unversioned group. Children do not inherit membership. Metadata and display names do not infer a group. OTel maps `datool.group.type`, `datool.group.name` and `datool.group.version`.

Groups associate operations across traces. For example, three step traces with the same workflow group remain three traces with their original operation types. Traces and span trees retain the recorded kinds and hierarchy without synthetic agent/workflow wrappers. Explicitly recorded agent/workflow operations still appear. The Details tab shows trace and selected-span memberships separately, with links to the corresponding Agents or Workflows page.

The group identifies a named definition and version across runs. It does not identify a distinct execution: three step traces count as three operations, even if they were part of one workflow execution.

Costs use `attributes["cost.usd"]` as a finite nonnegative JSON number. PATCH replaces attributes, so retain other attributes when recording a new total. Historical unclassified records remain unclassified.

## Metric definitions

- **Operations:** persisted member span/trace rows starting in the selected half-open time window; this is not a count of distinct workflow executions.
- **Error rate:** errored / (completed + errored). Running and cancelled invocations are displayed separately. No eligible outcomes means an unavailable rate, not 0%.
- **Average/P95 latency:** valid persisted end minus start times for completed/errored invocations. P95 uses nearest rank. Child durations are not summed, and unfinished invocations receive no live-clock duration.
- **Reported cost:** available inclusive costs, including running and partial reports. If an invocation reports its own cost, that total overrides descendant costs. Otherwise descendant costs are summed, pruning any subtree with an inclusive reported total so it is counted only once within the invocation.
- **Cost coverage:** invocations with a cost report and no missing descendant LLM cost after pruning, divided by invocation count. Missing/invalid LLM costs or invalid ancestor cost values make descendant-derived totals partial. Without any reported cost, the value is unavailable rather than zero. Coverage describes recorded instrumentation; uninstrumented provider calls cannot be detected.

Nested named invocations have overlapping inclusive costs. Do not add performance rows together as a workspace billing total, including recursive invocations with the same name.

The static `agents` and `workflows` models use the PostgreSQL SQL aggregation and paging contract described in [bounded data reads](bounded-data-reads.md). Name plus nullable version is the default grouping. The 90-day query window remains; raw-fact caps are removed. Apply migrations through `0009_independent_span_groups.sql` for independent span membership. Existing explicit memberships and recorded kinds are preserved; the migration cannot recover kinds overwritten by earlier ingestion. Production capacity remains unqualified.


## Storage and query execution

Trace drilldowns use persisted group memberships, including separately grouped
child spans; repeated memberships return a trace once. Invocation metrics keep
root and child invocations distinct. Group/name/version predicates use dedicated
indexes. Additive count/average queries can use transactionally maintained hourly
summaries. Exact p95 and descendant cost accounting use raw facts; partial hours
read exact edge facts alongside complete hourly summaries, while ID filters
retain the raw path. Summary updates and raw
writes commit together, and dashboard batches read one snapshot.
