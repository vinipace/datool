---
name: datool
description: Use Datool MCP, CLI, SDK and browser WebMCP to connect apps, integrate managed prompts, debug AI workflows, submit AI-labelled reviews, route evaluation work and customize Page or Object Views.
---

# Datool

## Connection and discovery

For custom Datool screens, first read [choosing Page Views and Object Views](references/views.md). Use a Table Page View for collection settings, a React or MDX Page View for custom collection content, and an Object View for one trace or dataset item. Discover the deployed schemas before using a renderer or transport.

Use the user's configured connection; prefer connected MCP tools when both transports are available. Discover MCP operation schemas with `describe_agent_operations`. An MCP-only workflow does not require a local CLI or CLI credentials. Reuse verified project and capability information while the connection and task requirements remain unchanged.

When using the CLI, check `datool --version` and installed help for the required commands. Run `datool doctor --json` during CLI setup or when diagnosing authentication, compatibility or connection failures. Inspect server schemas with `datool agent tools <operation>` and execute catalog operations with `datool agent call <operation> --input @input.json`. Base agent commands require CLI 0.2.0; the base convenience examples target the tested published CLI 0.3.0. Newer aliases and bridge protocols require separate capability checks; see [app compatibility](references/apps.md#compatibility). A repository version does not establish package publication, installation or server deployment.

For CLI agents/CI, supply DATOOL_BASE_URL, DATOOL_PROJECT_ID and DATOOL_API_KEY through the environment or an uncommitted project env file. For interactive use, `datool auth login --datool <host>` opens browser organization/project selection and saves tokens in the OS credential store. API keys take precedence. The CLI loads project-root `.env`, then `.env.local`; shell values win. `--env-file <path>` replaces those files; `--no-env` disables loading. Normal `npx datool`/`bunx datool` uses Node; direct Bun execution requires `bun --no-env-file <datool.js> ...`. Keep credentials out of commits, command arguments and reports. Doctor distinguishes incompatible servers, invalid credentials (401), and missing permissions (403, including traces:read).

MCP tokens are bound to a project and consented scopes. Discovery lists operation contracts; it does not prove the current credential can execute them. Missing tools can mean insufficient consent, while an unknown operation can mean the deployed server predates it. Doctor checks compatibility, authentication and a minimal trace read; it does not check every evaluation scope, app or provider. Use returned IDs and schemas, then verify the operations needed for the user's flow.

For local development, `datool connect --watch` reloads source/import edits in fresh processes and resyncs schemas after active calls and result delivery finish; watching is opt-in and HTTP registrations are unchanged. Check installed CLI help for support.

For playground apps, local-to-hosted connections and HTTP webhook registration, read [app connections](references/apps.md). The shared operations include list_apps, get_app, register_app and run_app. AI/sandbox provider setup and custom-sample scorer previews still use separate UI surfaces; managed prompt operations are not in the shared catalog. Inspect discovery before assuming a newer server has closed these gaps.

For evidence review, criteria changes or a review's starting trace view, read [AI-labelled reviews](references/reviews.md). API-key and OAuth agents can submit notes, scores and annotations with trusted server attribution; completion is not human verification. Item-specific criteria changes and shared session defaults have different scopes.

For published prompt fetching, rendering, invocation-scoped overrides and connected prompt experiments, read [managed prompts](references/prompts.md). Confirm installed SDK and deployed server support before using the native API.

## Workflow ownership

Read the focused skill matching the work; follow its handoff links when the task reaches another workflow:

- [datool-traces](../datool-traces/SKILL.md): investigate failures, latency and session behavior using recorded evidence.
- [datool-scorers](../datool-scorers/SKILL.md): develop, preview, calibrate and version JavaScript, Python or LLM scorers.
- [datool-datasets](../datool-datasets/SKILL.md): curate cases, perform atomic edits and freeze runnable snapshots.
- [datool-evaluations](../datool-evaluations/SKILL.md): execute apps, re-score frozen evidence, compare runs and gate CI.
- [datool-analytics](../datool-analytics/SKILL.md): query semantic metrics, create frozen reports, preview dashboards, resolve links and export bounded data.

For a regression investigation, connect the relevant workflows: inspect representative traces, define the failure criterion, curate cases, freeze dataset/scorer versions, execute the evaluation, then compare and gate it. Preserve the user's chosen scope and existing authorization for app execution and model costs.

Record the project, resource IDs, versions, inspected population and evidence limitations. A completed run means execution finished; quality requires the gate and case-level evidence. Source code, local tests and production behavior are distinct evidence.

For production invocation evaluation, start with [span promotion and snapshots](../datool-datasets/SKILL.md#promote-production-spans-into-cases), then follow its scorer and evaluation handoffs.
