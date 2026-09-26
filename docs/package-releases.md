# Package releases

Datool distributes three independently versioned packages:

| Package | Registry | Version source | Release workflow |
| --- | --- | --- | --- |
| Python `datool` | PyPI | `packages/python-sdk/pyproject.toml` | `publish-python-sdk.yml` |
| TypeScript `@datool/sdk` | npm | `packages/sdk/package.json` | CircleCI `operation=publish`, `release-package=sdk` |
| CLI `@datool/cli` | npm | `packages/cli/package.json` | CircleCI `operation=publish`, `release-package=cli` |

Merging a PR runs verification; it does not publish any package. Both registries are published manually from `main` with an exact version. npm
uses CircleCI; PyPI retains its GitHub workflow until CircleCI trusted publishing
is available in this PyPI account. Only release
packages that changed. Keep the application root's `private: true` to prevent
publishing the application to npm; this does not control GitHub repository visibility.

## One-time PyPI setup

For the first Python release, sign in to the intended owner account at
[PyPI Publishing](https://pypi.org/manage/account/publishing/) and add a **pending
GitHub publisher** with these exact values:

| PyPI field | Value |
| --- | --- |
| PyPI project name | `datool` |
| Owner | `vinipace` |
| Repository name | `datool` |
| Workflow name | `publish-python-sdk.yml` |
| Environment name | `pypi` |

Create the matching GitHub repository environment `pypi`, permitting deployments
from the `main` branch only. If `datool` already exists under your PyPI account,
add the same publisher under that project's Publishing settings instead.
If another account owns the name, resolve ownership or choose a different
distribution name before releasing; a pending publisher does not reserve it.

No PyPI API token or GitHub repository secret is needed. PyPI trusts this workflow
and environment through OIDC. Only the publishing job has `id-token: write`; it
downloads verified distributions and invokes the official PyPA publishing action,
without running the build or tests with publishing credentials. See
[PyPI's pending publisher guide](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/).

## Release the Python SDK

1. Change the version in `packages/python-sdk/pyproject.toml`, run
   `uv lock --project packages/python-sdk`, and merge the version change to `main`.
2. Dispatch the release with that exact version:

   ```sh
   gh workflow run publish-python-sdk.yml --repo vinipace/datool --ref main -f version=0.1.0
   ```

3. Wait for **Publish Python SDK** to finish, including **verify-published**.

Automatic Python verification runs in CircleCI's `python-verify` job. Feature
branches test Python 3.12; main and manual CircleCI runs cover Python 3.10, 3.12,
and 3.14. Each branch runs Python checks, including changes outside the SDK.
CircleCI auto-cancels superseded non-default-branch workflows; main and release
runs are preserved.

The manual GitHub PyPI release calls `.github/workflows/python-sdk.yml`, which
has no automatic triggers. It always checks all supported Python versions.
Both providers use `scripts/ci-python-sdk.sh`: lint, formatting, types, the
wheel/source build, and metadata checks run once. Every selected Python version
tests a clean installation of the same wheel. That wheel is also tested through
authenticated Datool handlers, Redis, the ingestion worker, and disposable
PostgreSQL. Mismatched versions and unexpected files fail before publication.

Only after every verification job succeeds does publishing upload that same
wheel and source archive to PyPI, with attestations. A separate job compares
PyPI's SHA-256 digests with the tested files, installs `datool[langchain]==VERSION`
from PyPI in a fresh environment without the package cache, and runs the contracts.
The requested version is passed as data through environment variables, never
interpolated directly into shell code.

After the first successful release, users can install:

```sh
pip install datool
pip install 'datool[langchain]'  # Automatic LangChain/LangGraph/agent callbacks
```

Python releases are immutable. If upload succeeds but verification fails, fix the
verification problem and rerun the failed verification job; do not overwrite or
silently skip an existing version. If package contents need correction, bump the
version and run a new release. A failed GitHub run, an uploaded Actions artifact,
or local tests alone are not evidence of a published package.

For local artifact validation without publication:

```sh
uv build --project packages/python-sdk
uv run --project packages/python-sdk python packages/python-sdk/scripts/release.py check --dist packages/python-sdk/dist --version 0.1.0
DATOOL_TEST_PYTHON_WHEEL="$PWD/packages/python-sdk/dist/datool-0.1.0-py3-none-any.whl" bun run test:python:integration
```

Use a clean build output directory when changing versions: the artifact check
rejects stale wheels/source archives as well as unrelated files. The `verify`
subcommand performs a read-only check of the same files against PyPI after release.

## Release npm packages

Both npm packages use CircleCI trusted publishers, restricted to the
`datool-npm` context. See [CI activation](ci.md#activation-and-credentials) for
the registered organization, project, pipeline, repository, and context IDs.
After merging a package version change, trigger a CircleCI pipeline on `main`:

| Parameter | SDK example | CLI example |
| --- | --- | --- |
| `operation` | `publish` | `publish` |
| `release-package` | `sdk` | `cli` |
| `release-version` | `0.3.0` | `0.4.1` |

These versions illustrate the manifests in this checkout; do not republish a
version already on npm. The job checks metadata, builds/tests the selected
tarballs, and publishes with OIDC. CircleCI npm publishing currently does not
produce provenance attestations. The CLI release also runs a clean registry
installation test. See [npm packages](npm-packages.md) for tarball verification
commands and local authenticated publishing.

After publication, users install `npm install @datool/sdk` or
`npm install --save-dev @datool/cli`. No Datool repository checkout is needed.
Server deployment is a separate operation from package releases.
