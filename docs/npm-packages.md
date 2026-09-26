# npm packages

The Datool application root stays unpublished on npm, regardless of GitHub repository visibility. This checkout builds:

| Package | Contents | Version |
| --- | --- | --- |
| `@datool/sdk` | Managed prompts and invocation overrides, manual and OTel tracing, typed API client, processor, call context, OpenAI fetch wrapper | `0.3.0` |
| `@datool/cli` | Node `datool` executable, `defineApps`, outbound app bridge with prompt scope, dataset/scorer sync | `0.4.1` |

Both require Node 22.18+ and ship ESM JavaScript and TypeScript declarations. Consumers need no Bun runtime, build tools, Next.js, or Datool checkout. SDK subpaths and setup are documented in [the SDK README](../packages/sdk/README.md); commands and permissions are in [the CLI README](../packages/cli/README.md).

Source remains in `src/lib/tracer`, `src/lib/playground/contracts.ts`, `bin`, and the shared webhook adapter. Thin entries in `packages/*/src` select public exports; tsup bundles those sources without repository aliases. SDK and CLI versions are independent; publish only packages that changed. There is no shadcn registry package.

## Build and verify

From the repository root, with Bun 1.3.14, npm, and Node installed:

```sh
bun install --frozen-lockfile
bun run pack:packages
bun run test:packages
```

Packing checks the file allowlist and rejects repository imports. Tarballs contain only built JavaScript, declarations, metadata, README, and the Apache License 2.0 text. `test:packages` installs the actual tarballs in a temporary directory, checks all public TypeScript entrypoints under NodeNext, and exercises manual tracing, OTel context, and the Node CLI against an HTTP fixture. The `verify` job in `.circleci/config.yml` repeats this on Node 22.18 and 24.

Before publication, install local tarballs in a calling app:

```sh
cd /path/to/consumer-app
npm install --ignore-scripts /path/to/datool/artifacts/npm/datool-sdk-0.3.0.tgz /path/to/datool/artifacts/npm/datool-cli-0.4.1.tgz
```

After publication, replace those file dependencies with `@datool/sdk@0.3.0` and `@datool/cli@0.4.1`. Rebuild, repack, and reinstall whenever the package source changes; npm can retain an installed tarball when its path/version is unchanged, so copy the updated tarball to a new filename before reinstalling it.

## Consumer application acceptance

To run an external application's package acceptance script, pass its directory
explicitly. Install the tarballs in that application first and start Docker:

```sh
bun run test:packages:integration /path/to/consumer-app
```

The consumer must provide `tests/datool-packages.mjs`. The runner creates
disposable loopback PostgreSQL and Redis containers, migrates a random schema,
seeds a fixture organization/project/API key, and hosts the authenticated API
route handlers with the ingestion worker. It runs the consumer script with
`DATOOL_BASE_URL`, `DATOOL_API_KEY`, and `DATOOL_PROJECT_ID` configured, then
cleans up its services, schema, and temporary files.

The consumer script should exercise the installed SDK and CLI without live model
providers. The runner requires at least four persisted traces and ten lifecycle
receipts. This checks package interoperability; it is not a deployment or
capacity test. For self-contained package checks, use `bun run test:packages`.

## Publication

See [package releases](package-releases.md) for the shared npm/PyPI release process.

Both packages use `Apache-2.0` and include the complete license text. CLI 0.4.1
fixes watched reloads after CLI 0.4.0; the SDK is unchanged by this release and
must not be republished. Deploy the compatible relay first, then publish the
exact tested CLI tarball. See
[the release notes](releases/cli-0.4.1.md).

```sh
bun run check:release 0.3.0 sdk
bun run check:release 0.4.1 cli
npm publish artifacts/npm/datool-cli-0.4.1.tgz --ignore-scripts --access public
npm view @datool/sdk@0.3.0 version dist.integrity
npm view @datool/cli@0.4.1 version dist.integrity
node scripts/test-cli-distribution.mjs 0.4.1
```

With no version argument, `bun run check:release` validates each package at its
own version. The optional
package argument is `sdk`, `cli` or `all` (default).

For CI releases, add a **CircleCI** trusted publisher to each npm package using
its CircleCI organization ID, project ID, pipeline definition ID, VCS origin
`github.com/vinipace/datool`, and the `datool-npm` context ID. Restrict that context
to this project and `pipeline.git.branch == "main" and not job.ssh.enabled`.
Run a pipeline on `main` with `operation=publish`, `release-version` set to the
exact manifest version, and `release-package=sdk`, `cli`, or `all`.

The job validates metadata, builds and tests tarballs, stores artifacts, obtains
an npm-audience OIDC token, and publishes only the selected packages. CircleCI
trusted publishing currently does not generate provenance attestations, so this
job omits `--provenance`. No long-lived npm token is used. See the official
[CircleCI npm guide](https://circleci.com/docs/guides/deploy/deploy-to-npm-registry/).
Ordinary pushes only verify packages. Dispatch SDK and CLI separately when their
versions differ. A successful package CI run alone does not publish a release.

Deploy the server's explicit grouping and bounded-read contract before directing released clients to that server. Legacy metadata like `agent.name` does not define an agent group; use the SDK group field or initial `datool.group.*` OTel attributes.
