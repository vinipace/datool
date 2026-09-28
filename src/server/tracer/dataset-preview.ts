import { sql } from "drizzle-orm"
import { DATASET_PREVIEW_CHARACTERS, DATASET_PREVIEW_FIELD_BYTES } from "@/src/lib/tracer/dataset-payload"

const fields = [
  ["input", "input_json", "inputJson", "null"],
  ["expectedOutput", "expected_output_json", "expectedOutputJson", "null"],
  ["metadata", "metadata_json", "metadataJson", "{}"],
  ["sourceSpanEvidence", "source_span_evidence_json", "sourceSpanEvidenceJson", "null"],
] as const

/** Bound values in PostgreSQL before transferring or parsing them in the web process. */
export function datasetItemProjection(preview: boolean) {
  const identity = sql`id,project_id as "projectId",dataset_id as "datasetId",version_id as "versionId",source_trace_id as "sourceTraceId",source_span_id as "sourceSpanId",created_at as "createdAt",updated_at as "updatedAt"`
  const values = fields.map(([, column, alias, empty]) => {
    const value = sql.identifier(column)
    return preview
      ? sql`case when octet_length(${value}) > ${DATASET_PREVIEW_FIELD_BYTES} then ${empty} else ${value} end as ${sql.identifier(alias)}`
      : sql`${value} as ${sql.identifier(alias)}`
  })
  const omitted = preview ? sql`, jsonb_strip_nulls(jsonb_build_object(${sql.join(fields.flatMap(([field, column]) => {
    const value = sql.identifier(column)
    return [sql`${field}::text`, sql`case when octet_length(${value}) > ${DATASET_PREVIEW_FIELD_BYTES} then jsonb_build_object('bytes',octet_length(${value}),'preview',left(${value},${DATASET_PREVIEW_CHARACTERS})) end`]
  }), sql`, `)})) as "omittedFields"` : sql``
  return sql`${identity},${sql.join(values, sql`, `)}${omitted}`
}
