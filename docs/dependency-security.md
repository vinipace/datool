# Dependency security

Check JavaScript advisories with `bun audit` after a locked installation. Review
runtime reachability as well as severity; an affected development tool is not
automatically an exposed server vulnerability. Do not publish keys or customer
payloads in reproduction cases.

The open-source release updates Payload and its companion packages together,
and updates Monaco to use a patched DOMPurify. Two temporary root overrides
keep transitive tools on patched versions:

- `image-size` 2.0.4 replaces Storybook's affected 2.0.2 image parser within the
  same major version. See [JXL/HEIF](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq)
  and [ICNS](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) advisories.
- `esbuild` 0.28.2 avoids the older development-server advisories inherited by
  build and migration tooling. Validate package bundles, application builds,
  and database migration commands when changing or removing this override.

Revisit overrides as upstream packages update their dependencies. Run the
production image/self-hosting acceptance, package consumer tests, and docs checks
before release. Keep dependency changes separate from package publication;
changing the application lockfile does not publish a new SDK version.

Security reports use the [private reporting process](../SECURITY.md).
