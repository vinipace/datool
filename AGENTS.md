<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Production logs

- Start production log investigations in the operator's configured logging service; see [the logging runbook](ops/gcp-logging/README.md#find-production-logs) for query and source filters. Obtain installation-specific project, host, and access details from the operator's private runbook.
- Google Cloud Logging uses resource `generic_node` with the installation's node ID and namespace. Streams are `datool.container` (web, worker, PostgreSQL and Redis), `datool.nginx` and `datool.host` (selected host services and kernel events).
- Use an existing authorized Google identity to read logs. The collector service account has only Logs Writer; its root-only key is not a reader credential.
- Check the incident time window, the installation's forwarding start time, and log freshness before drawing conclusions. Missing records do not prove the absence of an incident. These operational logs are separate from customer traces stored by Datool.
- Never commit installation-specific host addresses, cloud identities, access instructions, or real execution artifacts. Keep private operational records outside this repository; generated `artifacts/` outputs are ignored.

## Product styling contract

- Traces is the visual reference: black canvas, subtly raised neutral rows, restrained borders and compact controls. Preserve its appearance when migrating styles.
- Use semantic utilities for product colors: `bg-background`, `bg-muted`, `text-foreground`, `text-foreground-muted`, `border-border`, `ring-ring`, and semantic status/selection tokens. Raw palette classes, literal colors and inline color values belong only in the central token definitions or explicitly documented data-visualization exceptions.
- `app/globals.css` owns color values. `text-foreground-muted` is the canonical muted text name; `text-muted-foreground` remains a compatibility alias for existing consumers.
- Inspect and reuse shared UI components before adding a control. Put reusable variants and interaction styling in `components/ui/`, not page-local class strings. Reuse shared collection headers and table styles; resource-specific layouts and behavior remain with their pages.
- Follow `docs/ui-style-standard.md` and `docs/shared-product-patterns.md`. Run `bun run check:styles`, typecheck and scoped lint for UI changes; visually check affected loading, empty, error, focus and responsive states.
- New product UI files must obey the style check. Existing exceptions are migration debt, not examples to copy. Do not add exceptions merely to make a check pass.
- Only spawn subagents when the user explicitly requests delegation.

## Agent skills distribution

- Datool's six public user skills are maintained and shipped from [`skills/`](skills/README.md) in this repository. Install them with `npx skills add vinipace/datool --skill '*'`.
- Keep complete skill folders together, including references and assets. Follow [`skills/AGENTS.md`](skills/AGENTS.md) and run `bun run check:skills` after changes. Application contract-test inputs remain in `tests/fixtures/agent-operations/`.
- Coordinate skill changes with the server/CLI capabilities they require. Distinguish local or proposed changes from changes merged into the shipping branch; do not report a local copy as published.
