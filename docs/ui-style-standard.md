# UI style standard

Traces defines the product's visual language. The theme is centrally owned in `app/globals.css`; pages consume semantic tokens and shared controls. Preserve the existing trace canvas and row colors when migrating.

| Purpose | Utility |
| --- | --- |
| Page canvas | `bg-background` |
| Raised neutral surface / row | `bg-muted` or `bg-surface-row` |
| Text input / textarea fill | `bg-input-background` |
| Hovered row | `bg-surface-row-hover` |
| Primary content | `text-foreground` |
| Secondary content | `text-foreground-muted` |
| Less prominent metadata | `text-foreground-subtle` |
| Border / keyboard focus | `border-border` / `ring-ring` |
| Selected content | `bg-selection text-selection-foreground` |
| Errors / warnings / success | Named semantic status tokens |

`text-muted-foreground` remains compatible with shared library consumers but new product code uses `text-foreground-muted`. Do not create a second palette in page code. Charts, syntax highlighting and categorical data colors may use narrowly documented exceptions; ordinary page surfaces and controls may not.

Use shared Button and form primitives for controls, shared notices for feedback, shared dialog framing for overlays, and the shared log-table styles for tabular collections. Auth and settings layouts may differ from trace exploration while using the same surface, typography and interaction rules. Preserve authentication, authorization, navigation and resource behavior during styling changes.

### Dashboard charts

`app/globals.css` owns the dashboard palette (`--data-series-1` through `--data-series-4`, emphasis, and total). `components/tracer/dashboard-chart-style.ts` is the shared color selector for bar, line, and stacked charts. Each horizontal bar chart uses one palette color for all its items; consecutive bar widgets use consecutive palette colors, independent of pagination and filtering. Standalone line charts default to foreground (white in the dark theme), with a subtle area gradient fading to transparent; additional lines use distinct series colors. Stacked time charts retain their metric mappings (LLM/average, other spans, tool/P95, and cache); totals without a plotted series use the neutral total token. Use labels as well as color to identify categories.

The UI reference page exercises these primitives and their states. Before completing UI work, run the style guard, typecheck and scoped lint, then inspect the affected routes and reference page in the browser. Record which states were actually checked. Automated style checks supplement visual review; they cannot establish visual quality.

Dashboard formatting follows the display context: metric cards and numeric axes use compact counts with lowercase `k`/`m`/`b` and up to two rounded decimals. Legends, tooltips, and tables retain full grouped counts. Currency uses two decimals everywhere; metric-card cents are smaller and muted. Category bars place wrapping labels and full values over a subtle bar fill, so narrow cards do not clip names into unreadable axis ticks. These are shared defaults, not per-widget settings.

Metric tile histories span the card width with a muted line and subtle area fill: errors and failures use the destructive token, successful outcomes use success, and other counts use foreground (soft white in the dark theme). Their color describes the measure, while the comparison delta describes improvement or regression. Standalone bars share a six-pixel corner radius. Dashboard table bodies use muted foreground, retaining stronger column headings.

## Shared component owners

Use `components/ui/button.tsx`, `input.tsx`, `textarea.tsx`, `select.tsx`, `checkbox.tsx`, `switch.tsx`, `card.tsx`, `notice.tsx`, and `dialog.tsx`. Native input/select props remain available. Standard Input and Textarea controls use `bg-input-background`; title inputs and plain textareas stay transparent. `Button loading` disables the control and announces busy state. `Notice variant` accepts info, success, warning and error. Dialog content supplies its overlay, portal and focus behavior. `components/auth/auth-shell.tsx` owns auth framing. Tables use `components/tracer/log-table-styles.ts` with the existing table behavior components.

## Enforcement and review

`RunningSpinner` in `components/ui/execution-status.tsx` supplies the shared radial spinner for running traces and spans. Place it immediately after the kind icon in trace rows, the span hierarchy, detail headings, and timeline labels. It announces "Running" and respects reduced-motion preferences. Trace rows use `logTable.runningRow` for a subtle warning-token tint while running.

`bun run lint` also enforces `shadcn/no-raw-colors` in `app/` and
`components/`, including shared primitives and stories. Choose replacement
tokens by their purpose rather than accepting the nearest-color suggestion.
Keep the style guard below: it additionally checks CSS, arbitrary literal
colors, and inline values that the ESLint rule does not cover.

`components/workspace/settings-shell.tsx` owns settings framing and navigation; compose it for organization settings pages.

Run `bun run check:styles` and `bun test tests/style-guard.test.ts`. The local pre-push hook runs both, plus lint, typecheck, and shared-control tests; install it with `bun install` or `bun run hooks:install`. These checks do not run in a separate GitHub workflow. The guard examines static string/template literals in app/components and CSS, rejects palette utilities, literal arbitrary colors, and literal inline/SVG colors. It allows semantic CSS variables and arbitrary dimensions. It cannot evaluate colors assembled dynamically at runtime; those require review.

`scripts/style-baseline.json` records existing legacy occurrences by file, exact signature and count, including older chart/syntax colors. Additions fail even inside legacy files. The migrated pages and shared controls are always strict; new files have no allowance. Remove baseline entries as their consumers migrate. Never expand the baseline to accommodate a new page or style. Purposeful categorical/chart colors should use semantic data tokens, or receive a narrowly reasoned review before changing the guard.

The development-only `/ui-reference` page covers shared controls, disabled/loading/invalid states, feedback, selected and hovered table rows, and dialogs. It is unavailable outside development. Review at desktop and narrow mobile widths, use Tab and Escape, and compare the four product pages against this reference. The PR checklist records this review. Screenshot comparison remains a visual review step rather than an automated pixel test.
