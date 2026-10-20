# CI checks

Local pushes run `bun run check:pre-push`: full source lint, the UI style guard,
TypeScript checks, shared-control tests, and hook regression tests. `bun install`
installs the Git pre-push hook; `bun run hooks:install` reinstalls it without
reinstalling dependencies. Run `bun install` in each new clone before pushing.

The installer preserves an existing custom pre-push hook and prints instructions
to add `bun run check:pre-push` to it. Linked worktrees share a dispatcher that
loads the hook from the checkout being pushed. Older branches without the
tracked hook are unaffected. CI and Docker builds skip hook installation.
GitHub web edits and explicitly bypassed hooks do not run these local checks.

## CircleCI

[`.circleci/config.yml`](../.circleci/config.yml) runs automatic verification,
deployment, npm and Hermes publishing, and disk monitoring.
GitHub Actions remains only for manual PyPI releases and their reusable verification
workflow because this PyPI account does not yet offer CircleCI trusted publishers.
Connect the `vinipace/datool` repository to CircleCI using its existing
GitHub OAuth integration and this config path. Branch pushes run verification
and image acceptance; main additionally deploys the production image. No production secrets
are needed for verification or image builds.

### Fast deployment checks

Ordinary branch pushes run `verify`, `production-image`, `python-verify`, and
`hermes-verify` in parallel. Only `main` can deploy. Its deployment waits for
`verify` and `production-image`; SDK/plugin packaging does not block an
application release. The existing GitHub PR check names stay unchanged.

`verify` retains full lint, semantic style checks, TypeScript,
release/SSH/archive safety, organization and request
authorization, ingestion admission/order, execution-credit enforcement, and
Composio tenant isolation/idempotency. Lint/styles, types, and critical tests
run concurrently on the same runner; every group must finish successfully.
The critical suite runs once. It does not run the full browser, scale, recovery,
or package-compatibility suites.

`production-image` verifies generated public API/docs contracts as part of the
application build, then runs the actual deployable image through its acceptance
checks: repeatable application and CMS migrations, CMS rendering, denied
unauthenticated requests, API persistence, ingestion delivery, Build-worker
knowledge indexing, non-root execution, and persistent files. Production still
checks all three processes and public endpoints after importing that same
checksummed image. Branch image jobs have no deployment credentials.

The target is **3–5 minutes from a main push to a healthy deployment with a warm
build cache**, not a guaranteed timeout. The previous measured release spent
40m40s in verification, 5m59s building/testing the image in parallel, and 2m42s
in deployment. A cold cache, dependency upgrade, migration, slow host, or queued
runner can exceed the target. Compare complete workflow timings, not just the
shorter verification job.

### Build reuse

- Docker layer caching preserves dependency and build layers between image jobs.
  Dependencies are installed before copying application source; workspaces and
  postinstall generation still run in the final build. A named `datool-release`
  BuildKit container keeps its state and cache mounts in a persistent volume.
- BuildKit retains Next's build cache without copying it into the runtime image.
  Bun downloads use temporary memory-backed storage: the installed dependency
  layer is already cached, and keeping both displaced useful build layers.
- CI supplies `DATOOL_CI_BUILD=true` to the image build to avoid a second
  TypeScript pass. The required `verify` job runs the full typecheck in parallel.
  Local and self-hosted Docker builds default to checking types inside Next.
- BuildKit writes a Docker archive with fast layer compression. Acceptance loads
  that exact archive; no second `docker save` is needed. `pigz` prepares the
  transfer while acceptance runs. Both must succeed before the archive is
  checksummed and handed off. The archive format,
  checksum verification, commit/pipeline identity, restricted SSH command, and
  serialized production release remain unchanged.
- After handoff, the disposable runner retains the latest accepted
  `datool-release` image and removes older tags. DLC keeps installed shared
  layers without accumulating every released image. The named BuildKit cache
  is capped at 9 GB by removing its least recently used entries. This leaves
  room for runtime and service images: an oversized DLC snapshot was observed
  being discarded entirely, making the following build cold.

[CircleCI Docker layer caching](https://circleci.com/docs/guides/optimize/docker-layer-caching/)
costs 200 credits per image job, in addition to runner usage. It is enabled for
branch images as well so a reviewed change can warm the subsequent main build.
Cache availability is an optimization, never proof that tests passed.
Set `verify-image=false` on a manual branch pipeline to skip its image check;
main always builds and tests its image.

### Extended regression checks

The longer checks run every day at **06:32 UTC** on `main`, and on demand with
pipeline parameter `operation=regression`. They never deploy or receive
production credentials. Run them before merging a risky change; a nightly
failure means a regression may be detected after an application release.

| Job | Coverage |
| --- | --- |
| `regression-backend` | The complete Bun suite once, with PostgreSQL, Redis, runtime assets and real scorer containers; managed-prompt HTTP and durable evaluation-recovery scenarios. Includes billing reconciliation, scale, caching, runtime, channel, and trace regressions. |
| `regression-browser` | Compiled-production Build browser flows, desktop/mobile authoring, public chat and worker delivery; simulated WhatsApp/Meta lifecycle scenarios. |
| `regression-packages` | Public skill discovery and minimum published CLI; build tarballs once and exercise those same packages and watched CLI under Node 24, Node 22, and Bun. |
| `python-verify`, `hermes-verify` | Python wheel/ingestion and Hermes packaging/install checks. These also retain their short branch checks. |

The backend, browser, and package jobs run independently. The full backend suite
replaces the former long list of overlapping targeted invocations. Runtime-
specific package checks and real-container tests remain because they exercise
different environments. Tests are retained; moving them off the deployment path
changes **when regressions are caught**, not their assertions.

### Workflows

| Workflow | Trigger | Effect |
| --- | --- | --- |
| `ci` | Branch pushes; default manual pipeline | Fast source checks and deployable image acceptance. Deploys on main after both pass. |
| `regression` | Manual, `operation=regression` | Fast verification plus all extended regression jobs; never deploys. |
| `nightly-regression` | 06:32 UTC daily, main | Extended backend/browser/package/Python/Hermes regression checks; never deploys. |
| `publish-packages` | Manual, `operation=publish`, main | Verifies release tarballs, publishes using npm OIDC, and checks the published CLI. Requires `release-version` and `release-package`. |
| `publish-hermes` | Manual, `operation=publish-hermes`, main | Tests and packages the source-only plugin, then publishes the verified ZIP/checksum. Requires `release-version`. |
| `disk-health`, `scheduled-disk-health` | Manual or 00:17, 06:17, 12:17, 18:17 UTC | Restricted host disk check. |

The machine executor keeps Docker, databases, and tests on the same host.
Deployment and publication retain separate CircleCI serial groups. No branch,
regression, package build, or image build receives production secrets.

### Activation and credentials

Before merging the migration, run the branch in CircleCI and configure these
contexts. Restrict each context to **this project**, with the expression
`pipeline.git.branch == "main" and not job.ssh.enabled`. Keep credentials out of
project-wide environment variables, which are available to branch jobs.

| Context | Variables |
| --- | --- |
| `datool-production` | `DOKKU_NETCUP_SSH_PRIVATE_KEY`, `DOKKU_NETCUP_SSH_KNOWN_HOSTS`, `DOKKU_SSH_HOST`, `DATOOL_URL` (your public HTTPS origin) |
| `datool-monitor` | `NETCUP_MONITOR_SSH_PRIVATE_KEY`, `NETCUP_MONITOR_SSH_KNOWN_HOSTS`, `DOKKU_SSH_HOST` |
| `datool-npm` | No static npm token; restrict the context and register its ID with npm. |
| `datool-hermes` | `GH_TOKEN`: a fine-grained GitHub token restricted to this repository, with **Contents: read and write**. |

Use dedicated keys for the `datool-deploy` and `datool-monitor` accounts and
verified host keys. GitHub does not expose stored secret values: the key owner
must supply them directly to CircleCI. If the original private keys are no longer
available, generate replacement key pairs and authorize their public keys with
the accounts' existing `restrict,command=...` wrappers. Keep the previous keys
until cutover succeeds. Do not substitute a maintainer's unrestricted SSH key.
Configure the npm trusted publisher as described in [npm packages](npm-packages.md).
For Hermes, create a dedicated fine-grained GitHub token with a bounded expiry,
select only this repository, and grant Contents read/write (Metadata read is
automatic). Save it as `GH_TOKEN` in `datool-hermes` after applying the project
and main-branch context restrictions above. Rotate it before expiry. The token
is used only by `hermes-publish`; no GitHub token is needed for verification.

SSH keys must use OpenSSH private-key format. CircleCI's secret form removes
pasted line breaks; the shared SSH setup restores the armor and validates the
private key locally before contacting the host. Multiline and CRLF values work
as well. Key contents are never printed.

Register your own CircleCI organization, project, pipeline definition, VCS origin,
and npm context IDs in npm's trusted-publisher configuration for both packages.
Keep installation-specific identifiers in your private operator runbook and
recheck them if recreating the project, pipeline, or context.

The existing OAuth integration supports the scheduled workflow in this file.
If switching to the CircleCI GitHub App later, replace the scheduled workflows
with schedule triggers using `operation=disk-health` and `operation=regression`,
both on branch `main`.

Complete the cutover only after a successful branch verification and image test,
the restricted contexts, and npm trust configuration are ready. After merging,
verify the main deployment and a manual disk-health run. Check CircleCI failure
notification preferences. The former automatic GitHub Actions workflows disappear
in that merge. Keep Actions enabled for the manual PyPI release; see [package releases](package-releases.md).

Validate edits with `circleci config validate .circleci/config.yml`, the release
safety tests, and `python3 -m unittest discover -s tests -p 'dokku_*_test.py'`.

Enable **Auto-cancel redundant workflows** in CircleCI project Advanced settings
to cancel superseded non-default-branch runs. Main, scheduled workflows, and reruns
are excluded from this setting. Keep **Pass secrets to builds from forked pull requests**
disabled. Verify both settings in your project before enabling public contributions.

## Storybook

Storybook is available locally through `bun run storybook`, `bun run test:storybook`,
and `bun run build-storybook`. It does not run automatically in CircleCI
or in pre-push. General TypeScript checking is retained in pre-push and the
required CI verification job; local production builds also check types.
