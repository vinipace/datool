# Public skill distribution

This directory distributes the six user workflows listed in [README.md](README.md). Keep maintainer deployment skills, server administration, private runbooks and incident records outside this pack.

Use synthetic examples and placeholder resource IDs. Never add installation-specific hosts, access details, local user paths, credentials or captured application data, including in tests, screenshots and supporting assets.

Review every new supporting file for public distribution. Run `bun run check:skills` from the repository root after changes. Keep the six-skill allowlist in place; adding a skill requires an explicit decision that it belongs in the user distribution.

Import only reviewed source files from other repositories. Do not copy Git metadata, recovery bundles, audit artifacts or ignored local files into this pack.
