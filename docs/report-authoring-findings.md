# Findings from authoring an evaluation story through MCP

The existing API can capture a professional narrative using text, matrices and
charts with complete frozen results. Report-only row/cell highlights now address
exact dimension values; they can be authored through MCP, HTTP or CLI.

Items 1–5 are implemented in the report and semantic-query contracts. See
[Reports](reports.md#sources-bindings-and-capture) for inputs and limitations.
The authoring findings that motivated them:

1. **Evidence-bound text — implemented.** Narrative numbers were copied from reviewed
   queries. Bind a statement to a frozen widget cell and a supported calculation
   so the server can verify changes, denominators and deltas at capture time.
   For this report, the author checked the exact fixture aggregates before saving
   and verified the saved results through a second interface.
2. **Native classification metrics — implemented.** Precision is not an arbitrary average
   quality score. A first-class confusion matrix should expose TP/FP/FN/TN,
   precision, recall, F1 and denominators for a selected positive class. This
   fixture uses binary scorers on explicitly eligible cases; excluded cases have
   null scores, never zero.
3. **Paired evaluation comparisons — implemented.** Show which fixed dataset cases improved or
   regressed across candidates, with sample sizes and appropriate uncertainty.
   Avoid confidence claims for constructed synthetic fixtures.
4. **More annotation targets — implemented.** Highlights previously covered matrix rows/cells.
   Bar and line point annotations, reference thresholds, and scatter plots of
   quality versus cost would make tradeoffs easier to explain.
5. **Presentation labels and units — implemented.** Agent-supplied display aliases for dimensions
   and columns, readable dataset names instead of IDs, and explicit cost-per-case
   or latency-unit settings would reduce explanatory prose.
6. **Print/PDF output — not implemented.** The current export is JSON. A paginated print layout
   should keep narratives, legends and frozen evidence together for distribution.

The local authoring inputs, reviewed query results and readback proof are kept in
ignored `artifacts/evaluation-story/`. They are execution artifacts, not shipped
fixtures. The seed script is reusable; the report clearly labels its scenario data.
