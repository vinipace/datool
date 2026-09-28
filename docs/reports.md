# Author an MDX report

Reports are stored and sent through APIs as `{ name, description, mdx, sources, bindings }`. Author them as two files: `report.mdx` contains the narrative and layout; `report.data.json` contains `name`, `description`, named `sources` and evidence `bindings`. The CLI bundles them into the same validated document. Queries use the existing semantic metrics contract. Components reference source names, never fetch data themselves.

The paired MDX file has no YAML header. Keeping query definitions and large label maps in the data file makes prose and layout edits easier to review. A self-contained MDX file with YAML frontmatter remains supported when there is no companion data file.

Start with `get_report_authoring_guide` (CLI: `datool reports guide`) for the contract, examples, recipe, validation scope and next steps. Discover `get_report_components` and `get_report_recipe` for their individual details. The component catalog supplies the exact prop schemas and supported Tailwind utilities. The recipe is guidance for an evaluation story, not a fixed layout. `get_report_template` returns `{ id, name, description, document }` as a starter for a particular query shape.

## Agent workflow

1. Inspect metrics metadata and query the intended population. Pin candidate and scorer versions, use absolute date windows, and check denominators, units, missing scores and coverage.
2. Write the MDX document. Lead with the answer and key limitation, show a few bound metrics, explain changes, compare candidates, put detailed evidence under disclosures, and close with the decision and next step.
3. Validate with `validate_report({document})`. This parses syntax, validates props and source references, executes a read-only capture, checks evidence against component requirements, and smoke-renders the shared React document, including components inside closed disclosures. It saves no report. Diagnostics include severity, message and MDX line/column. Results distinguish structural, data and render checks from visual and responsive review, which are not run by the API.
4. Create with `{...document, creationKey}`. Generate one UUID and save the exact input before sending. An identical retry returns the original report; changed input under the same key conflicts.
5. Read back the report and use `resolve_report` (CLI: `datool reports resolve <number>`) to get its private preview URL. Inspect it at desktop and mobile widths, expand the evidence disclosures, and review its quality warnings. Save screenshots of both views. Server rendering catches runtime failures; it does not establish chart readability, responsive behavior or visual quality.
6. Edit a draft using `{number, revision, document}`. Save preserves captured evidence. Changed queries or components needing additional aggregation require explicit `refresh: true`. Re-review refreshed data.
7. Publish the reviewed revision only when authorized. Publication does not refresh queries. Public sharing is a separate action. Published reports are immutable; cloning starts a new private draft with the same evidence.

```sh
datool reports guide
datool reports components
datool reports recipe
datool reports validate --file report.mdx
datool reports create --file report.mdx --creation-key <uuid>
datool reports get 12
datool reports resolve 12
datool reports validate 12 --revision 1 --file report.mdx
datool reports update 12 --revision 1 --file report.mdx
# When deliberately refreshing the query capture:
datool reports update 12 --revision 2 --file report.mdx --refresh
datool reports publish 12 --revision 3
datool reports share 12 --revision 4 --enabled
```

For `--file report.mdx`, the CLI automatically loads a neighboring `report.data.json`. Use `--data-file custom-data.json` to choose another filename. The companion file is resolved next to the MDX file; it is not a remote resource or a path declared by untrusted MDX content. Do not repeat frontmatter fields in a paired MDX file.

`--input @report.json` and generic `agent call` also work. JSON creation has a flat document plus creationKey; JSON update/validation nests the document under `document`. CLI validation exits 1 for invalid documents. Creation and updates are not automatically retried. Reconcile uncertain updates by reading the current revision.

## File example

This illustrates the contract, not a finding. Replace the window, selectors and narrative after inspecting actual data.

`report.data.json`:

```json
{
  "name": "Candidate evaluation",
  "description": "Explain the decision and population after inspecting evidence.",
  "sources": {
    "quality": {
      "query": {
        "measures": ["evalResults.meanScore"],
        "dimensions": ["evalResults.groupVersion"],
        "timeDimensions": [{
          "dimension": "evalResults.completedAt",
          "dateRange": ["2026-09-01T00:00:00Z", "2026-09-08T00:00:00Z"]
        }]
      }
    }
  },
  "bindings": {
    "candidateScore": {
      "source": {
        "source": "quality",
        "measure": "evalResults.meanScore",
        "dimensions": { "evalResults.groupVersion": "v4" }
      },
      "operation": "value",
      "format": "percent",
      "decimals": 1
    }
  }
}
```

`report.mdx`:

```mdx
<ReportHeader title="Candidate evaluation" summary="Describe the observed result and its limitation." />

<Metrics columns={1}>
  <Metric binding="candidateScore" label="Candidate average" />
</Metrics>

The candidate's average is <Value binding="candidateScore" />.

<Details id="evidence" title="Explore the evidence">
  <Table source="quality" title="Captured candidate scores" />
</Details>
```

## Components and styling

| Component | Purpose |
| --- | --- |
| `ReportHeader` | Eyebrow, headline, summary and disclosure; can contain hero metrics |
| `Metrics`, `Metric`, `Value` | Evidence-bound hero values and inline numeric claims |
| `Section`, `Callout`, `Details` | Narrative structure, emphasis and expandable evidence |
| `Chart` | Shared bar, line, stacked, scatter or donut chart |
| `Matrix`, `Table` | Shared heatmap/matrix and paginated table |
| `Progression` | Ordered stages and metric series with stage descriptions |
| `Comparison` | Candidate comparison with baseline differences and best values |
| `Scorecard` | Selected candidate, baseline changes and optional explicit targets |

Props accept strings, booleans or literal JSON inside braces. Object keys must be quoted. Use `className="grid gap-6 md:grid-cols-2"` on an allowed container for responsive composition. Only the catalog's static Tailwind utilities and semantic color tokens are accepted; classes are compiled into the application stylesheet.

Markdown supports headings, paragraphs, emphasis, lists, links, code and tables. The catalog's `htmlTags` lists supported HTML, including ordinary `<h1>`, `<p>`, nested emphasis and `<br />`; these compose with Markdown and inline `<Value />`. Invalid HTML nesting is rejected. There are no imports/exports, arbitrary components, JavaScript expressions, event handlers, spreads, raw styles, scripts or remote embeds. The server parses MDX to a validated AST and renders registered React components; it never evaluates authored JavaScript. IDs are unique and document links must resolve. Images are not supported yet.

`Chart`, `Matrix` and `Table` accept `source`, optional `title`, `caption`, `series`, `presentation`, `highlights` and `references`. Charts also require `type`; plot height is small, medium or large. Styling and number formatting reuse the shared dashboard components. Chart annotations use exact selected dimension values and native numeric units. Their props omit widgetId because the component identifies the target. Zero is valid; unmatched highlights fail validation, including edits against frozen data.

Comparison and Scorecard use `source`, a categorical `dimension`, all 2–8 `candidates` (`value`, `label`), explicit `baseline` and `candidate`, and `metrics` (`member`, `label`, `direction`, optional `target`). Each candidate must resolve to one row. Higher selects the maximum and lower the minimum, including ties; neutral and missing data have no winner. Rates show percentage-point differences; other measures show relative changes, or absolute differences for zero baselines. Targets must come from actual requirements, never invented acceptance criteria.

Progression uses `source`, `dimension`, `measures` (`member`, `label`) and ordered `stages` (`value`, `label`, `title`, `description`). Reuse a named source across components, but avoid displaying the same chart twice. MDX renders what the author places; it does not silently remove repeated components.

## Sources, bindings and capture

A source contains `{query, presentation?}`. Source presentation can provide readable member labels, aliases, units and decimal precision; components may override it. Query selectors always use original keys and values. A matrix's final dimension forms columns. `presentation.showSummary: true` captures the overall row aggregate from underlying records, not an average of displayed averages. Missing values remain missing.

Bindings are named records with a `source` selector `{source, measure, dimensions}`, `operation`, optional `baseline`, formatting, and optional expected value/tolerance. Operations are value, difference, relativeChange, ratio and percentagePoints. Calculations require compatible units and exactly one numeric cell per selector. Missing/ambiguous cells, zero denominators and stale expected values fail validation. Use `<Value binding="id" />` in prose; component text props can use `{{evidence.id}}`. Numeric claims typed freely in prose remain the author's responsibility.

Creation captures all unique queries in one database snapshot. Identical queries shared by components are deduplicated. Frozen rendering, pagination and disclosure expansion issue no live metric queries. Limits: 20 named sources, 100 bindings, 100 data components, 40 expanded queries, 5,000 rows per query and about 8 MiB total saved content. Oversized/incomplete captures fail atomically without consuming a report number.

Draft MDX and source definitions are stored alongside the compiled AST and captured results. Saving prose, layout or compatible chart changes reuses those results. Query changes require explicit refresh. Publication freezes the reviewed revision. Public readers receive only the renderable AST and sanitized frozen evidence, not the authoring file, private query selectors or creator identity.

## Review and sharing

In the UI, the pencil icon replaces the rendered document with a code editor and becomes a Save icon. The MDX tab opens the narrative by default; the Data tab edits the JSON metadata, sources and bindings. Both tabs save together as one document. Saving validates and returns to the report; errors leave the editor open. Cancel discards unsaved changes. The refresh checkbox explicitly opts into new evidence. There is no layout picker or widget canvas.

Creation requires dashboards:write plus metrics:read. Validation and saved-report reads require dashboards:read plus metrics:read. Component/template/recipe discovery requires dashboards:read. Mutations are revision-checked and project-scoped. Authors are captured from the authenticated user or API key; clients cannot supply them.

`publish_report({number, revision})` locks the reviewed version while keeping it private. `set_report_sharing({number, revision, enabled:true})` returns a public URL. Anyone with the URL can read all captured evidence. Revocation disables future reads, and re-enabling rotates the token. `clone_report({number, creationKey})` creates a private editable copy. Ordinary draft creation does not authorize publication or public sharing.

Apply migration `0045_reports.sql` before running this authoring contract. It creates the complete report schema, including MDX, authorship, draft publication and sharing. The supported creation/update format is MDX; the former config/presentation authoring payload is not accepted.
