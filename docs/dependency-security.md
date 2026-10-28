# Dependency security

Check JavaScript advisories with `bun audit` after a locked installation. Review
runtime reachability as well as severity; an affected development tool is not
automatically an exposed server vulnerability. Do not publish keys or customer
payloads in reproduction cases.

CI runs `bun audit --audit-level high` after a frozen install and blocks reported
high/critical advisories. The full local `bun audit` also includes lower severities.
A scan depends on the advisory service and its current knowledge; a clean result
is not a penetration test or proof that an installation is secure. Container and
OS packages require separate scanning and patching.

The security refresh updates Next.js to 16.4.3, the MCP SDK to 1.32.2, Storybook
to 10.6.3, Vitest to 4.1.12, Vite to 7.3.7 and Zod to 4.6.7. Compatible transitive
patches are locked as well. Temporary root overrides cover upstream pins:

- `image-size` 2.0.4 replaces Storybook's affected 2.0.2 image parser within the
  same major version. See [JXL/HEIF](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq)
  and [ICNS](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) advisories.
- `esbuild` 0.28.2 avoids the older development-server advisories inherited by
  build and migration tooling. Validate package bundles, application builds,
  and database migration commands when changing or removing this override.
- `dompurify` 3.4.17 replaces Monaco's exact 3.4.15 pin. See the
  [sanitization advisory](https://github.com/advisories/GHSA-cg2g-xh64-v4q7)
  and `bun audit` for current findings. Validate editor rendering after updates.
- `undici` 7.30.1 replaces older 7.x copies, including Payload's exact pin;
  exercise provider HTTP, authentication, CMS and sandbox paths.
- `zod` 4.6.7 also replaces MCP extensions' exact 4.4.3 dependency. All installed
  consumers accept Zod 4 or already pin a 4.x version; this override must be
  reconsidered if a future consumer requires Zod 3. Validate tool schemas and
  package consumers, not just TypeScript compilation.
- `happy-dom` 21.0.4 replaces Lexical headless's 20.x dependency to address
  [host code execution](https://github.com/advisories/GHSA-834v-8h66-3h79).
  This crosses a major version: validate the real CMS rich-text pipeline and
  production image. Happy DOM is not a security sandbox; do not enable script
  evaluation for untrusted HTML.
- `toml` 5.0.1 replaces Effect's 4.x parser to address resource-exhaustion
  advisories, including [unbounded parsing work](https://github.com/advisories/GHSA-4qx8-w7c3-pj3p).
  The consumer uses `parse(string)`; validate CLI/package execution when changing
  this major-version override. Both updated packages require Node 20 or newer,
  within Datool's supported Node 22/24 environments.

Revisit overrides as upstream packages update their dependencies. Run the
production image/self-hosting acceptance, package consumer tests, and docs checks
before release. Keep dependency changes separate from package publication;
changing the application lockfile does not publish a new SDK version.

Security reports use the [private reporting process](../SECURITY.md).
