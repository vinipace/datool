# Datool Storybook

The component catalog uses Storybook 10.5.10, Next.js/Vite, real `app/globals.css`, dark/light themes, Autodocs,
accessibility checks, MSW 2 with its Storybook addon 3, and Vitest in Chromium. Existing Bun tests remain
under `bun run test`.

Docs and component previews use dark mode and the same `--background` canvas as the app.
Preview backgrounds are controlled by the app theme. The default padded layout
gives percentage-sized editors and charts a real parent width; use centered
layout explicitly only for examples with an intrinsic or fixed width.

```sh
bun install --frozen-lockfile
bunx --no-install playwright install chromium # once per machine
bun run storybook                           # http://localhost:6006
bun run build-storybook                     # storybook-static/
bun run test:storybook
bun run test:storybook components/ui/button.stories.tsx
bun run storybook:coverage
bun run storybook:coverage --built-index      # after build-storybook
bun run typecheck
bun run lint:storybook
bun run check:styles
```

The start, build, and test scripts generate Monaco workers and trace-view assets
with the existing `build:monaco` command. MSW's committed worker lives in
`.storybook/public`, keeping it out of the production Next.js public directory.
Regenerate it after upgrading MSW with
`bunx --no-install msw init .storybook/public --no-save`.

Stories live beside components as `<name>.stories.tsx`; `app/` stories are also
supported. Start from `components/ui/button.stories.tsx` for typed props/actions
and `components/tracer/collection-page.stories.tsx` for mocked loading, empty,
error, retry, retained refresh, header portals, and pagination. Feature stories
use real API paths and production response types.

Each story gets its own QueryClient and the shared TooltipProvider. Add MSW
handlers through `parameters.msw.handlers`. Unhandled `/api/` requests and
external HTTP requests fail; local assets pass through. Use local image fixtures,
fixed IDs/dates, and no live services or credentials. Fonts currently use the
system fallbacks from the production CSS; Next's Inter/Geist font loaders are
not imported. Browser tests use the app's dark theme and fail accessibility
violations. Light-theme review requires an explicit story-level
`parameters.themes.themeOverride: "light"`; it is outside the default catalog.
The existing light secondary-button tokens have a known contrast failure (2.64:1).
Span-kind icons use the central invocation color tokens. Timeline clock labels
use the muted foreground token, and their contrast is enforced by the timeline
and trace-viewer browser stories. Timeline stories wait for visible span content
before running accessibility checks.

The following dark-theme stories retain inherited accessibility findings as
`parameters.a11y.test: "todo"`. Their interactions still fail on regressions and
axe results stay visible, but **all axe violations in these specific stories are
nonblocking** until the underlying defects are fixed. Do not copy these exceptions
to new stories or disable global rules.

| Stories                                                                                                                                       | Production finding                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace-apikeyspage--owner`, `--member-without-permission`, `--creation-disabled`, `--loading`, `--load-failure-and-retry`, `--revoke-key` | API keys `.text-foreground-subtle`: 4.34:1 on the canvas, 3.99:1 on raised rows.                                                                                                                                                        |
| `tracer-evals-computedcolumns--editor-and-inspector`                                                                                          | `SortableFieldSection` in `eval-computed-columns.tsx` nests a focusable drag handle inside a disclosure summary; its format label has 4.35:1 contrast at 11px. Fixing this requires coordinating keyboard drag and disclosure behavior. |

Additional documented cases:

- `ui-codeeditor--read-only-selection`: Monaco's existing dark selection palette
  gives JSON strings 3.21:1 contrast. The editor interaction tests support both
  textarea and Chromium EditContext inputs; synthetic select-all uses Monaco's
  real command before a paste and does not prove OS shortcut handling.
- Trace inspector stories and the trace detail route expose 4.35:1 metadata/tab
  contrast (4.22:1 for evaluator IDs). Histogram stories expose 2.49:1 timestamps;
  trace list/page compositions also expose 3.99:1–4.34:1 summary text. The empty
  trace table message is 4.34:1. Exact source paths are in each story description.
- `tracer-collectionheader--open-display-menu`,
  `tracer-tableviewcontrols--open-display-menu`, and
  `tracer-tracelisttoolbar--open-display-menu`: axe finds focusable triggers under
  an aria-hidden host in Storybook's portal composition. Production impact has
  not been separately verified. Companion stories exercise selection and dismissal.
- Connected-eval catalog failure, legacy-playground app-list failure, and
  playground trace-stream failure expose 4.4:1 error-notice text; the completed
  playground attempt exposes a 3.73:1 trace metadata count. These retain their
  functional assertions with a story-level accessibility TODO.
- Legacy execution and received playground traces also expose stable overflow
  tag contrast of 3.73:1 and 3.99:1 respectively. These stories wait for row
  animations to finish before accessibility checks.

Scoped lint of the production files touched by these accessibility repairs still
reports the existing `custom-view-controls.tsx` synchronous state update in an
effect. Story/fixture/config lint
is checked separately with `lint:storybook`; these existing production diagnostics
are not suppressed.

## Component catalog and ownership

The catalog is maintained in six batches plus Canvas. Each batch owns adjacent
stories, its `.storybook/scenarios/<batch>/` fixtures, and its
`.storybook/coverage/<batch>.json` manifest. Coordinate shared configuration and
production changes separately when working in parallel.

Run `bun run storybook:coverage` for the current component and story totals.
The checker discovers new component files automatically and requires each one
to have direct coverage, composite coverage, or a justified nonvisual classification.

| Batch              | Ownership                                                                                                          | Main coverage                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| UI                 | `components/ui/*.tsx` only                                                                                         | Variants, keyboard/focus, disabled/loading/invalid states, overlays, editors, virtualization.                 |
| Datool UI          | `components/ui/datool/**/*.tsx`                                                                                    | Search/filter editing, trace viewer/zoom/selection.                                                           |
| Auth/workspace     | `components/auth/*.tsx`, `components/workspace/*.tsx`                                                              | Forms, permissions, selectors, creation, API errors, Better Auth and workspace requests.                      |
| Traces/collections | `components/tracer/*.tsx` except the next two batches                                                              | Lists, timeline, inspectors, sessions, shell, filters, view controls, header portals, refresh and pagination. |
| Datasets/evals     | Tracer basenames starting with `dataset`, `eval`, `scorer`, `playground`, `legacy-playground`, or `connected-eval` | Schema/import/history/editing, eval comparison/actions/scores, scorers and playground.                        |
| Dashboards         | Tracer basenames starting with `dashboard` or `performance`                                                        | Charts, renderers, builders, detail/list, fixed series data, filtering and save flows.                        |
| Canvas             | `components/ui/canvas/`                                                                                            | Layout editing, resizing, removal, serialization and validation.                                              |

`component-frame.tsx` supplies the real ProjectScopeProvider and collection
header portal targets for feature stories. Set matching `parameters.nextjs.navigation`
route params explicitly when a component also reads Next navigation. Datool
stories use the real Datool instance/provider from their batch fixtures.
`scenarios/auth-workspace/handlers.ts` includes reusable Better Auth organization
handlers; `workspaceProjectHandlers()` covers project REST endpoints.

Coverage is checked against the live `components/**/*.tsx` inventory:

- `direct`: an adjacent CSF story imports the component.
- `composite`: a named story reaches a provider, barrel, or child component
  through runtime imports, with a written reason explaining its exercise.
- `helper`: a nonvisual module with a reason; JSX-rendering files cannot use it.

The checker rejects missing, stale, duplicate, unreachable and untracked entries.
`--built-index` also requires actual stories in `storybook-static/index.json`.
This is structural coverage, not proof of every possible prop combination.
Meaningful states and real interaction assertions remain part of story review.
New visual exports should extend the corresponding story and manifest.

Run scoped browser tests while authoring. Parallel processes must choose distinct
ports, for example `STORYBOOK_TEST_PORT=63401 bun run test:storybook <story-path>`.
Avoid running many Chromium suites at once. The GitHub Storybook workflow checks
coverage, types, lint, browser tests, and the static catalog, then uploads the
build as an artifact. Existing Bun unit tests remain independent.

Route files under `app/` are a separate follow-up after component coverage.
Client page components under `components/` are included above. For server routes,
story the browser-safe view with serializable props; any extraction needs its
own production review. Do not import database/auth server loaders or enable
experimental RSC just to make a story build.

References: [Next.js/Vite framework](https://storybook.js.org/docs/get-started/frameworks/nextjs-vite),
[Vitest addon](https://storybook.js.org/docs/writing-tests/integrations/vitest-addon),
and [MSW addon](https://github.com/mswjs/msw-storybook-addon).
