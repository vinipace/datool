# Contributing to Datool

Datool provides AI traces, evaluations, datasets, prompts, and project-scoped
analysis. Small, focused pull requests are welcome. Discuss substantial product
or API changes in an issue before implementation.

## Development

Use Node.js 22.18+ or Node 24, Bun 1.3.14, and Docker with Compose v2. Follow
[local setup](README.md#local-setup), including a Google or Resend login provider
and an explicit sign-in policy. PostgreSQL and Redis are required. Run the
ingestion worker alongside the web application when testing trace ingestion.

```sh
bun install --frozen-lockfile
bun run check:pre-push
bun run check:docs
```

`bun install` installs the repository's pre-push checks. The full image acceptance
test is `bun run test:self-hosting`; it creates disposable PostgreSQL/Redis
volumes and captures fixture mail locally. It needs Docker and a Playwright
Chromium installation. Its login test does not send real email. See
[CI checks](docs/ci.md) for package, Python SDK, sandbox, and deployment checks.

Use synthetic fixtures. Do not commit local `.env` files, credentials, customer
traces, generated screenshots/reports, or production infrastructure details.
Generated evidence belongs under ignored `artifacts/`.

## Pull requests

- Explain the problem, resulting behavior, and how you verified it.
- Add a focused regression test for a behavior change where it provides useful
  coverage. Keep migrations additive and preserve existing migration files.
- For UI changes, follow [the style standard](docs/ui-style-standard.md) and
  [shared product patterns](docs/shared-product-patterns.md); check desktop,
  mobile, loading, empty, error, and keyboard-focus states.
- Read `AGENTS.md` and the installed Next.js guides before changing framework
  code. Keep public documentation in `content/docs/` in sync with behavior.
- Keep unrelated cleanup out of the change. Do not include build outputs or
  generated execution evidence in the PR.

Public contribution checks do not need production secrets. Only restricted
maintainer workflows may deploy or publish packages. Datool agent skills live in
the separate [datool-skills repository](https://github.com/vinipace/datool-skills).

## Licensing and conduct

By submitting a contribution, you agree to license it under the project's
Apache-2.0 license. Preserve third-party copyright and license notices, and only
submit material you have the right to contribute. Treat contributors with
respect; keep discussion focused on the work.

Report security issues through [the private reporting process](SECURITY.md).
