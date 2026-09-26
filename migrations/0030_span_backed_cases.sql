ALTER TABLE dataset_items
  ADD COLUMN source_span_id text,
  ADD COLUMN source_span_evidence_json text,
  ADD CONSTRAINT dataset_items_span_evidence_check CHECK (
    (source_span_id IS NULL AND source_span_evidence_json IS NULL) OR
    (source_span_id IS NOT NULL AND source_trace_id IS NOT NULL AND source_span_evidence_json IS NOT NULL)
  );

-- Keep captured evidence after the live span changes or is removed.
CREATE OR REPLACE FUNCTION dataset_item_document(item dataset_items) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'input', item.input_json::jsonb,
    'expectedOutput', item.expected_output_json::jsonb,
    'metadata', item.metadata_json::jsonb,
    'sourceTraceId', item.source_trace_id,
    'sourceSpanId', item.source_span_id,
    'sourceSpanEvidence', item.source_span_evidence_json::jsonb
  );
$$;
