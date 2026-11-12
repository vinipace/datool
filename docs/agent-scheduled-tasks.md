# Agent scheduled tasks

Open an agent, choose **Scheduled tasks**, then **New task**. Give the task a
name and instructions, choose one time, daily, weekly, or a custom five-field
cron schedule, and save. Recurring schedules use the selected IANA time zone,
including daylight-saving changes. The one-time date picker uses the browser's
local time. The table shows status, next run, and last result.

Use the row menu to run now, pause/resume, inspect run history, or delete a task.
Each occurrence starts a fresh conversation; **Open conversation** shows its
answer, tool calls and any approval or human input it requires. The scheduled
task does not send its final reply to an external channel. Its configured tools
can perform their normal permitted actions. Advanced settings selects which
published channel instructions, tools and guardrails apply.

## Execution

Apply `0082_build_agent_schedules.sql` and run the Build worker alongside Eve.
Datool stores schedules and admits their occurrences; Eve executes each admitted
agent turn through the normal runtime. No per-agent build is needed. Creation
and updates require both `build:write` and `build:run`; reads require
`build:read`, run-now requires `build:run`, and deletion requires `build:write`.

Each run freezes the task prompt and channel at queue time. The agent's latest
published revision is selected at turn admission and remains pinned during
recovery. Draft changes cannot affect execution. Jev, action approvals, budgets
and channel restrictions use the same runtime as interactive conversations.
Approvals, forms and handoffs are shown as **Needs attention**; guardrail denials
and failures are recorded in run history.

The scheduler commits the run and next date in one transaction. Concurrent
workers cannot admit duplicate occurrences or overlap runs of the same task.
After downtime, overdue recurring occurrences coalesce into one run, then
resume the future cadence. Pausing or changing the schedule cancels unstarted
scheduled runs; deleting also cancels unstarted manual runs. Already started
runs can finish. A one-time schedule becomes Finished after its occurrence ends.

Workers renew a 90-second lease. A recovered run reuses its conversation and
request key, allowing Eve to resume or replay the durable result. A turn that
stalled before establishing an Eve execution is marked failed for review after
ten minutes; it is not silently repeated. Eve's existing uncertain-action rules
still apply to external side effects.

## API and MCP

The UI uses the shared Build operation catalog:

- `build_list_scheduled_tasks`
- `build_create_scheduled_task`
- `build_update_scheduled_task`
- `build_delete_scheduled_task`
- `build_run_scheduled_task`
- `build_list_scheduled_task_runs`

Create a weekday task with an idempotency key:

```json
{
  "agentId": "your-agent-id",
  "name": "Morning summary",
  "prompt": "Summarize the latest information from the connected sources.",
  "schedule": { "kind": "cron", "expression": "0 9 * * 1-5" },
  "timezone": "America/Sao_Paulo",
  "channel": "web",
  "enabled": true
}
```

Updates include `id` and `expectedRevision`. Run-now is idempotent and returns
the current run if this task is already queued or running. These management
operations are available to authorized platform clients; they are not
automatically granted as tools to every customer-facing agent.
