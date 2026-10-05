# Datool skills

Agent skills for investigating AI traces, building scorers, curating datasets, running evaluations and querying Datool analytics.

This pack contains workflows for Datool users and synthetic examples. Maintainer deployment, server administration, private runbooks, credentials and captured application data do not belong in this repository.

## Install

Install the complete pack into a project:

```sh
npx skills add vinipace/datool --skill '*'
```

Target an agent explicitly:

```sh
npx skills add vinipace/datool --skill '*' --agent codex
npx skills add vinipace/datool --skill '*' --agent claude-code
npx skills add vinipace/datool --skill '*' --agent cursor
```

Add `--global` to install across projects. The [skills installer](https://github.com/vercel-labs/skills) supports these options and additional agents.

List the available skills before installing:

```sh
npx skills add vinipace/datool --list
```

Install an individual workflow with `--skill datool-traces`, for example. Install all six when using the general `datool` router, which links to the focused workflows.

## Migrating from datool-skills

If you installed from `vinpac/datool-skills` or `vinipace/datool-skills`, run the install command above again with the same agent and project/global scope. This switches the recorded source for future updates to `vinipace/datool`.

## Included skills

| Skill | Purpose |
| --- | --- |
| [datool](datool/SKILL.md) | Discover operations, integrate managed prompts and combine workflows |
| [datool-traces](datool-traces/SKILL.md) | Investigate traces, spans, sessions and scores |
| [datool-scorers](datool-scorers/SKILL.md) | Develop, preview and version scorers |
| [datool-datasets](datool-datasets/SKILL.md) | Curate cases, edit items atomically and freeze snapshots |
| [datool-evaluations](datool-evaluations/SKILL.md) | Execute apps, re-score evidence, compare runs and gate CI |
| [datool-analytics](datool-analytics/SKILL.md) | Query metrics, create frozen reports, preview dashboards and export data |

13 JSON assets accompany the focused skills. Replace their example resource IDs, request keys, thresholds and dates before executing them. Fresh connected-run starters select a dataset snapshot explicitly through datasetVersionId; replace it with the snapshot returned for the chosen dataset. Parent/source-run starters inherit cases from the observed run.

## Connect to Datool

Skills contain instructions and examples. Server workflows require an existing Datool deployment and either an authenticated MCP connection or a compatible Datool CLI. [Choose Page Views or Object Views](datool/references/views.md) before customizing Datool UI: Table Page Views save collection settings, React/MDX Page Views provide custom collection content, and Object Views render one record. Current definitions are shared project resources; discover the deployed schemas and browser tools before using newer renderers or navigation.

For MCP, connect your agent to your deployment's `/api/mcp` endpoint and complete its OAuth project selection and permission consent. Use `describe_agent_operations` to inspect available operations. MCP-only workflows require no CLI installation or CLI doctor checks. Reuse verified connection information across skill handoffs; see [connection and discovery](datool/SKILL.md#connection-and-discovery) for when to check again.

For current CLI commands, use Node 22.18+ and install `@datool/cli >=0.3.0`:

```sh
npm install --save-dev @datool/cli@^0.3.0
export DATOOL_BASE_URL=https://your-datool-host
export DATOOL_PROJECT_ID=your-project-id
# Set DATOOL_API_KEY through your environment or secret manager.
npx datool --version
npx datool doctor --json
npx datool agent tools
datool agent tools start_eval_run
```

For interactive use, `npx datool auth login --datool <host>` opens browser organization/project selection and stores credentials in the OS credential store. Agents and CI can continue using API-key environment variables. The CLI loads project-root `.env`, then `.env.local`; shell variables win. `--env-file <path>` replaces the automatic files, and `--no-env` opts out. Keep credential files out of version control. Normal `npx datool` and `bunx datool` use Node; direct Bun execution requires `bun --no-env-file <datool.js> ...`.

For CLI workflows, version 0.1.0 does not include the advertised agent commands; use a CLI with `agent` commands and a server exposing `POST /api/agent/:operation`. If discovery is unavailable, check deployment compatibility and credential scopes through the configured transport. Doctor and CLI OAuth require server CLI protocol 1. Doctor distinguishes an old server from invalid credentials (401) and valid credentials with insufficient permissions (403). A missing MCP tool can also mean the token lacks the necessary consented scopes.

A completed evaluation reports technical execution; use its quality gate to determine whether it passes. Connected app runs and LLM scorers can incur costs. Each skill documents its permissions, pagination, limits and reproducibility requirements.

For the native prompt SDK and connected prompt experiments, read [managed prompts](datool/references/prompts.md). Standalone fetching needs SDK support and `prompts:read`; connected experiments also need a compatible bridge or HTTP adapter, a server advertising `promptOverrides`, and the evaluation/trace permissions listed in the reference. Base CLI command support alone does not establish native prompt support.

## Capability checks

The published CLI 0.3.0 includes app connections and `connect --watch`, reviews, span promotion, runtime probes and per-case evaluation reads. Published SDK 0.2.0 exposes `createDatool().prompts` and `withDatoolRequest` from `@datool/sdk/context`. Install `@datool/sdk@^0.2.0` in applications using native prompts. Verify installed versions and the deployed server independently; package support does not prove server rollout or permission grants.

Recovery/cancellation, `parentRunId`, `useRecordedVersions`, `configurationChanges` and scorer-version baseline enforcement require a server that advertises them. Follow [recovery and cancellation](datool-evaluations/SKILL.md#recovery-and-cancellation) for installed-alias checks and generic-call fallbacks. Pass iteration fields through `--input` JSON.

The resilient app bridge requires bridge protocol 2. Follow [app compatibility](datool/references/apps.md#compatibility) and verify support on the connected server. CLI 0.3.0 provides the base commands; its version alone does not establish protocol 2 availability. Per-case snapshot storage also requires server support; verify the connected server's capabilities before relying on larger snapshots.

Older CLI 0.2.0 supports the base agent transport; use generic `agent call` when an alias is missing. Server configuration diagnostics, runtime probes, local code checks, package publication and deployed behavior are separate evidence.

## Use

For example, ask your agent:

- "Use $datool-traces to investigate the errors in the last 24 hours."
- "Use $datool-datasets to freeze these regression cases as a snapshot."
- "Use $datool-evaluations to compare this candidate run against its baseline."

CLI credentials, MCP configuration and application data are not included in this pack.

## Validate and maintain

Run these commands from the repository root.

```sh
bun run check:skills
node scripts/test-cli-distribution.mjs 0.3.0
```

The validation workflow checks pack structure, local references, JSON assets and installer discovery. It also installs the exact published npm CLI in a clean directory and exercises agent discovery, trace reads, env precedence and diagnostics under Node and Bun against a local HTTP fixture. It does not use workspace CLI source, run your application, or call LLM providers.

Maintain this pack in the Datool repository alongside the server and CLI. Keep complete skill folders together when updating them so examples and links remain available. Check command and permission changes against the compatible Datool server before publishing updates.

## License

[Apache License 2.0](../LICENSE).
