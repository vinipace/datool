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
GitHub OAuth integration and this config path. Branch pushes run verification;
main additionally builds and deploys the production image. No production secrets
are needed for verification or image builds.

| Workflow | Trigger | Coverage |
| --- | --- | --- |
| `ci` | Branch pushes; default manual pipeline | Builds SDK/CLI tarballs and runs backend/sandbox regressions once, then tests the same tarballs under Node 24 and 22.18.0. On main, builds and tests the production image, waits for package, Python SDK, and image verification, deploys that image, and checks the live app. Python checks test the built wheel and real ingestion on each branch; main and manual pipelines cover Python 3.10, 3.12, and 3.14. |
| `publish-packages` | Manual, `operation=publish`, main only | Checks release metadata, tests tarballs, publishes with npm OIDC, and verifies the published CLI. Requires `release-version` and `release-package` (`sdk`, `cli`, or `all`). |
| `publish-hermes` | Manual, `operation=publish-hermes`, main only | Tests and packages the plugin without credentials, then publishes that ZIP and checksum through a restricted job. Requires `release-version` matching `plugin.yaml`; creates `hermes-v<version>` at the tested commit, verifies downloaded assets, and preserves the global Latest release. |
| `disk-health` | Manual, `operation=disk-health`, main only | Checks the configured host through the restricted monitoring account. |
| `scheduled-disk-health` | 00:17, 06:17, 12:17, 18:17 UTC on main | Runs the same restricted disk check. |

Set `verify-image=true` on a manual `operation=verify` pipeline to test a feature
branch's production image. Feature branches never deploy. Publishing and disk
checks do not also run the ordinary CI workflow. Deployments and publications each
have their own CircleCI serial group, preventing overlapping releases.

The separate `hermes-verify` job runs on branch pushes and main, and gates
production deployment. It tests plugin delivery, reproducible packaging, and
installation from the extracted ZIP, then stores the source-only ZIP and SHA-256
checksum as CircleCI artifacts. It uses Python only and needs no credentials,
database, or Node dependencies. A successful preview does not publish a GitHub
Release; use the explicit `publish-hermes` operation described in the
[Hermes maintainer instructions](../integrations/hermes/README.md#publish-a-plugin-release-maintainers).

The machine executor keeps Docker on the same host as the tests, so sandbox bind
mounts, localhost fixture services, and the production acceptance script retain
their existing behavior. Package and Python SDK checks use 8 GiB VMs; production
image builds use a 16 GiB VM. Bun's download cache is keyed by lockfile and architecture.

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
If switching to the CircleCI GitHub App later, replace that scheduled workflow
with a schedule trigger using `operation=disk-health` and branch `main`.

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

The package job installs dependencies and starts PostgreSQL/Redis once. Backend
tests run with Bun; sandbox tests also exercise real JavaScript/Python Docker
containers and database-backed provider permissions, credentials, and project
isolation. Switching Node versions repeats only packed-package consumer checks
(including TypeScript declarations and Node CLI connect/watch) and CLI
distribution checks. CLI distribution coverage under Bun runs once, alongside
Node 24. The job uploads one set of tarballs tested on both Node versions.

## Storybook

Storybook is available locally through `bun run storybook`, `bun run test:storybook`,
and `bun run build-storybook`. It does not run automatically in CircleCI
or in pre-push. General TypeScript checking is retained in pre-push and the
production build.
