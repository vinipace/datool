# Views implementation

Canonical scope: [Page Views, Custom Fields, Object Views](./views-unification.md).

| Ticket | Depends on | State |
| --- | --- | --- |
| Contracts and compatibility adapters | — | In progress |
| Database revisions, history, preferences and migrations | Contracts | Implemented; compatibility/race review ongoing |
| HTTP, CLI, MCP and WebMCP parity | Persistence | Shared lifecycle catalog wired; data adapters and browser helpers in progress |
| Page Views and fields on shared tables/cards | Contracts, persistence | Shared LogTable, trace and dataset wiring in progress; bespoke tables pending |
| Object Views and typed dataset/trace inputs | Contracts, persistence | Typed runtime and separate durable defaults implemented; UI lifecycle and validation in progress |
| Cross-surface integration and migration tests | All implementation | 41 focused tests pass, including PostgreSQL persistence, revision conflicts, dependency history, field execution and preferences; broader integration pending |
| Desktop/mobile visual proof and review | Integration | Local authenticated checks cover the four primary Page View surfaces, loading geometry, keyboard focus and narrow layouts; full matrix pending |
| Dedicated skills update and PR delivery | Operations | Application draft PR prepared; dedicated skills changes pending |

Work is performed without subagents, following AGENTS.md. Keep this ledger current and report implementation, validation, publishing and deployment separately.

Local preview is running with a dedicated disposable PostgreSQL database and synthetic records. Authenticated trace collection loaded without browser errors. This is development proof, not complete coverage or deployment proof.

UI refinement: logs, evals, eval runs and dataset items share the Page View menu.
Draft changes remain in scoped local storage until explicit Save changes or Reset,
with a yellow changed indicator and no lock icons. Catalog requests are deduplicated
and cached. The local browser checks cover reload, switching, save conflicts,
explicit revisions, filters/grouping, keyboard focus and narrow layout. The broader
operation/coverage work above remains separate from this UI refinement.

PR validation found a merge blocker: `bun run check:docs` fails because the new
dynamic View operation catalog is missing generated response schemas, beginning
with `list_page_views`. Complete the typed response generation and regenerate the
API reference before merging. The required pre-push checks (lint, styles,
typecheck and shared-control/hook tests) pass. Bespoke table adapters, complete
Page View query coverage, browser helpers and the dedicated skills update remain
outside the completed four-page UI refinement.
