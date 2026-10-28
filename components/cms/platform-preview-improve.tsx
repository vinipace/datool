"use client"

import { useState } from "react"
import { CollectionPanel } from "@/components/tracer/collection-panel"
import { CollectionSearch } from "@/components/tracer/collection-page"
import { HeaderSlot } from "@/components/tracer/collection-header"
import {
  CollectionRow,
  CollectionTable,
  CollectionTableBody,
} from "@/components/tracer/collection-table"
import { collectionTable } from "@/components/tracer/collection-table-styles"
import { EvalComparisonSummary } from "@/components/tracer/eval-comparison-summary"
import { EvalMetricDifference } from "@/components/tracer/eval-metric-difference"
import { EvalRunSummary } from "@/components/tracer/eval-run-summary"
import { EvalScoreCell } from "@/components/tracer/eval-score-cell"
import { TableViewControls } from "@/components/tracer/table-view-controls"
import {
  defaultTableSettings,
  type CollectionTableSettings,
} from "@/src/lib/tracer/custom-views"
import {
  platformPreviewBaselineRun,
  platformPreviewCandidateRun,
  platformPreviewEvalCases,
} from "./platform-preview-fixtures"
import styles from "./platform-preview.module.css"

const cases = platformPreviewEvalCases

/** The eval run page's real result cells and comparison summary, using example data. */
export function ImprovePreview() {
  const [query, setQuery] = useState("")
  const [settings, setSettings] =
    useState<CollectionTableSettings>(defaultTableSettings)
  const filtered = cases.filter((item) =>
    item.input.toLowerCase().includes(query.toLowerCase())
  )

  return (
    <div className={styles.panels} data-area="improve">
      <div className={styles.traceList}>
        <CollectionPanel label="Example eval results" displayIconOnly>
          <TableViewControls>
            <HeaderSlot name="filter">
              <CollectionSearch
                label="Search example eval cases"
                value={query}
                onChange={setQuery}
              />
            </HeaderSlot>
            <CollectionTable
              selectionColumnWidth={0}
              enableCardView={false}
              reorderable={false}
              settings={settings}
              onSettingsChange={setSettings}
              widths={[230, 88, 88, 100]}
              columnIds={["input", "baseline", "candidate", "change"]}
            >
              <thead className={collectionTable.head}>
                <tr>
                  <th aria-hidden className="p-0" />
                  {["Case", "v1", "v2", "Change"].map((label) => (
                    <th key={label} className={collectionTable.heading}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <CollectionTableBody rows={filtered}>
                {(item) => (
                  <CollectionRow key={item.id} rowLabel={item.input}>
                    <td aria-hidden className="p-0" />
                    <td className={collectionTable.cell}>
                      <span className="block truncate">{item.input}</span>
                    </td>
                    <td className={collectionTable.cell}>
                      <EvalScoreCell
                        result={{
                          evaluatorName: "Helpful answer",
                          score: item.baseline,
                          passed: item.baseline >= 0.7,
                          status: "completed",
                        }}
                      />
                    </td>
                    <td className={collectionTable.cell}>
                      <EvalScoreCell
                        result={{
                          evaluatorName: "Helpful answer",
                          score: item.candidate,
                          passed: item.candidate >= 0.7,
                          status: "completed",
                          reasoning: item.reasoning,
                        }}
                      />
                    </td>
                    <td className={collectionTable.cell}>
                      <EvalMetricDifference
                        value={item.candidate}
                        baseline={item.baseline}
                      />
                    </td>
                  </CollectionRow>
                )}
              </CollectionTableBody>
            </CollectionTable>
          </TableViewControls>
        </CollectionPanel>
      </div>
      <section className={styles.inspector} aria-label="Example eval run">
        <div className={styles.evalSummary}>
          <EvalRunSummary run={platformPreviewCandidateRun} />
          <EvalComparisonSummary
            baseline={platformPreviewBaselineRun}
            runs={[platformPreviewCandidateRun]}
          />
        </div>
      </section>
    </div>
  )
}
