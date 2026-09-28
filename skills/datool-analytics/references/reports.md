# Create, review and publish an MDX report

Start with `get_report_authoring_guide` (CLI: `datool reports guide`). It returns the document contract, component examples and prop catalog, recipe, limits, validation scope and ordered workflow in one response. Server, CLI and skill releases ship independently. If the MDX contract is unavailable, identify the capability gap instead of sending the old config/presentation payload. An older CLI can use `datool agent call <operation> --input @input.json` when the server supports the operation.

## Produce the document

1. Read metrics metadata and query the intended population before writing conclusions. Use absolute time windows, source-specific filters and pinned scorer/candidate versions. Inspect denominators, cost coverage, missing values and quality warnings.
2. Read the component catalog for exact prop schemas and supported Tailwind utilities. Use the evaluation-story recipe as guidance: an opening answer and limitation, bound hero metrics, progression, candidate comparison, expandable supporting evidence, and a closing scorecard. Choose appropriate components yourself; readers should not have to choose a layout. Do not repeat the same widget in multiple sections.
3. Write `report.mdx` with Markdown, supported HTML and registered components, without frontmatter. Put `name`, `description`, `sources` and `bindings` in neighboring `report.data.json`. The CLI bundles both into one document; the data stays separate while editing prose. The self-contained [MDX example](../assets/evaluation-report.mdx) remains an alternative when no companion data file exists; [equivalent JSON input](../assets/evaluation-report.json) shows the API shape. Examples are shapes, not findings. Replace dates and selectors after inspecting data.
4. Validate the document. The server checks structure, captured data and the shared React renderer, including content inside closed disclosures; visual/responsive checks are explicitly not run. Create a private draft, resolve its URL, and inspect desktop (at least 1024px) and mobile (around 390px) rendering. Expand evidence disclosures and save screenshots. Check title hierarchy, whitespace, chart labels, readable numbers, useful disclosures and the final recommendation. A render pass is not proof of visual quality.
5. Let the user review/edit the draft. Publish only the reviewed revision when authorized. Public sharing is a separate authorized action.

```sh
datool reports guide
datool reports components
datool reports recipe
datool reports template evaluation-comparison
datool reports validate --file report.mdx
datool reports create --file report.mdx --creation-key <uuid>
datool reports get 12
datool reports resolve 12
datool reports update 12 --revision 1 --file report.mdx
```

MCP equivalents are `get_report_authoring_guide`, `get_report_components`, `get_report_recipe`, `get_report_template`, `validate_report`, `create_report`, `get_report`, `resolve_report` and `update_report`. The template returns `document`, not config. MCP/JSON creation takes `{creationKey,name,description,mdx,sources,bindings}`; validation takes `{document,number?,revision?,refresh?}`; update takes `{number,revision,document,refresh?}`. For `--file report.mdx`, the CLI automatically reads sibling `report.data.json`; `--data-file custom-data.json` selects another file. Metadata and queries are never loaded from paths or URLs declared inside MDX. A paired file must not also contain frontmatter. Without a companion file, the CLI reads self-contained YAML frontmatter. These file formats construct the same API payloads. CLI validation exits 1 for invalid documents.

Sources are named `{query,presentation?}` records. Use the semantic query contract, not SQL or browser state. Source names connect components to captured data. `<Table source="quality" />` and `<Chart source="quality" type="bar" />` can share a query. Identical queries are captured once. Source presentation supplies aliases, units and decimal precision; components can override it. Selectors use original names/values.

Bindings are named records. A selector is `{source,measure,dimensions}` and must resolve to exactly one numeric cell. Use `operation: "value"` for direct values, or difference, relativeChange, ratio or percentagePoints with a baseline selector. Optional `format`, `decimals`, `expected` and `tolerance` control formatting and stale-value checks. Units must agree; missing/ambiguous values and zero denominators fail validation.

Use `<Value binding="finalPrecision" />` inside prose and `<Metric binding="finalPrecision" label="Final precision" />` in a Metrics block. Component text props can use `{{evidence.finalPrecision}}`. Bind measured claims rather than copying numbers into prose. The server validates arithmetic and selectors, not causal interpretation or the truth of unbound narrative.

## Compose with the shared components

- ReportHeader: eyebrow, title, summary and disclosure; supports child Metrics.
- Metrics / Metric / Value: hero numbers and inline evidence.
- Section / Callout / Details: narrative, emphasis and expandable evidence.
- Chart: bar, line, stacked, scatter or donut; Matrix and Table use the shared data styles.
- Progression: one dimension, named metric series and ordered stages with descriptions.
- Comparison: all 2–8 candidates, an explicit baseline and selected candidate, and metric directions.
- Scorecard: final candidate and baseline changes, with targets only when actually specified.

Comparison and Scorecard use `source`, `dimension`, `candidates:[{value,label}]`, `baseline`, `candidate`, and `metrics:[{member,label,direction,target?}]`. Each candidate must match exactly one row. Higher highlights maxima, lower highlights minima, including ties; neutral has no winner. Use lower for cost and latency. Ratios show percentage-point changes; other measures show relative changes, or absolute differences with zero baselines. Do not invent thresholds or acceptance criteria. No target is not a pass.

Chart, Matrix and Table support `presentation`, `highlights`, `references`, titles and captions. Annotation props use exact dimension selectors and omit widgetId. Highlights must match non-null captured evidence. Reference values use native units (90% is 0.9; duration query values remain milliseconds). Matrix `presentation.showSummary:true` adds the overall row average from underlying observations, not an average of averages. Preserve missing values and incompatible scorer scales.

Allowed Tailwind classes are returned by the catalog. Use semantic colors and responsive containers such as `className="grid gap-6 md:grid-cols-2"`; keep chart styling consistent with shared components. Props accept strings or JSON literals (`columns={3}`, `metrics={[{"member":"...","label":"Precision","direction":"higher"}]}`). Object keys must be quoted. There are no imports, exports, arbitrary JS expressions, spreads, event handlers, raw styles, scripts or remote embeds. Markdown, code, links and tables are supported; images are not. Ordinary allowlisted HTML such as `<h1>`, `<p>`, `<strong>` and `<br />` can be mixed with Markdown and inline `<Value />` components. Invalid HTML nesting and executable expressions still fail validation.

## Preserve the reviewed evidence

Creation captures a single consistent database snapshot. Limits are 20 named sources, 100 bindings, 100 data components, 40 expanded queries, 5,000 rows per query and about 8 MiB of saved content. Partial/oversized captures fail atomically. Check results, total row counts, warnings and shared asOf before drawing conclusions. Frozen pagination and disclosures issue no live metrics queries.

Save the exact file/input and one UUID creationKey before creation. On uncertain delivery, resend the same input/key to retrieve the original. Changed input under the same key conflicts. Updates require the current revision; reread and reconcile conflicts instead of overwriting. Saving prose/layout reuses evidence. Query changes require `refresh:true` (CLI `--refresh`) and another review. `validate_report` can validate a draft revision against its frozen data without saving.

The UI pencil opens the MDX narrative and becomes an icon-only Save action. The Data tab edits the separate JSON metadata, sources and bindings. Both tabs save together; validation errors leave the editor open, and Cancel discards unsaved changes. Save validates before returning to the document. There is no widget canvas or layout picker. Users and agents edit the same document contract.

`publish_report({number,revision})` locks the reviewed report without querying again and keeps it private. `set_report_sharing({number,revision,enabled:true})` returns a public URL. Only enable it when authorized: anyone holding it can read all captured rows, including expanded evidence. Revocation disables future reads and re-enabling rotates the token; downloaded copies cannot be withdrawn. `clone_report({number,creationKey})` starts a new private draft of a published report without refreshing its data.

Discovery needs dashboards:read. Validation and saved-report reads also need metrics:read. Creation, updates, publication and sharing require dashboards:write plus metrics:read. Authors are captured from the authenticated user/key, not supplied by the document.

## Classification and paired cases

Discover `evalClassification` and `evalComparison` through `get_metrics_metadata`.
These sources require explicit query options and are authored through APIs/CLI;
they are not offered as unconfigured sources in the UI picker.

`evalClassification` requires this query option:

```json
{
  "classification": {
    "actualPath": ["datasetItem", "expectedOutput", "label"],
    "predictedPath": ["trace", "output", "label"],
    "positiveClass": true
  }
}
```

Paths address immutable evaluation-target snapshots. Labels must have the same
scalar type as `positiveClass`. This is one-vs-rest classification. Measures
include `tp`, `fp`, `fn`, `tn`, `precision`, `recall`, `f1`, `accuracy`,
`predictedPositiveCount`, `actualPositiveCount`, `validCount`, `missingCount`,
`caseCount`, `costCount`, `costUsd`, `meanCostUsd` and `syntheticCount`. Zero
ratio denominators return null. Group `caseCount` by `actual` and `predicted` in
a matrix for a confusion matrix. Missing labels are visible as excluded counts,
not false negatives. Multiple scorer or operation memberships do not multiply
cases. Repeated target executions are separate observations.

Workload costs come from saved `trace.attributes["cost.usd"]`, exclude negative
or missing values, and are not inferred scorer costs. `meanCostUsd` divides by
`costCount`; inspect coverage before comparing. The time member is `createdAt`.
Dimensions include readable `datasetName`, run, case, operation and candidate.
`evalResults.datasetName` is also available. Dataset names are presentation
metadata read at capture time; expected/predicted labels remain frozen evidence.

`evalComparison` requires:

```json
{
  "comparison": {
    "baselineRunIds": ["baseline-run"],
    "candidateRunIds": ["candidate-run"],
    "evaluatorVersionId": "fixed-scorer-version",
    "lowerIsBetter": false
  }
}
```

Both run sets must be unique, disjoint and within the requested `createdAt`
window. Pair identity is dataset ID plus item ID. Saved input and expected output
must match. Group by `status` or `caseId` to inspect excluded and changed cases.
Ambiguous duplicate executions, absent sides, changed/missing snapshots and
missing native scores are excluded. Scores are the pinned scorer's normalized
native numeric values; unsupported scales are not silently mixed.

Measures include `matchedCount`, `excludedCount`, `improvedCount`,
`regressedCount`, `unchangedCount`, `baselineMean`, `candidateMean`, `meanDelta`,
`deltaCiLow`, `deltaCiHigh` and `syntheticCount`. Delta is always candidate minus
baseline; `lowerIsBetter` changes the improved/regressed decision only. Confidence
bounds use the paired mean ± 1.96 standard errors, require at least 30 matched
pairs, and are suppressed for groups with tagged synthetic cases. These are
normal approximations assuming independent, representative cases, not causal or
simultaneous subgroup guarantees. Inspect quality warnings; null is unavailable.
