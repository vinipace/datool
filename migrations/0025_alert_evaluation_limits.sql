ALTER TABLE project_alerts ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0;
ALTER TABLE alert_events ADD COLUMN payload_bytes integer
  GENERATED ALWAYS AS (octet_length(payload::text)) STORED;

CREATE TABLE alert_project_budgets (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('mutation', 'evaluation')),
  window_start timestamptz NOT NULL,
  used integer NOT NULL,
  PRIMARY KEY (project_id, kind)
);

-- The reader login receives SELECT on this view only, never on the base tables.
-- Scope and window are supplied by trusted worker code using transaction-local
-- settings. Missing scope fails closed. Keep the predicates inside each branch
-- so both the security boundary and the project/time indexes survive UNION ALL.
CREATE VIEW alert_evaluation_logs WITH (security_barrier = true) AS
SELECT started_at_ms, jsonb_build_object(
  'id', id, 'trace_id', id, 'resource', 'trace', 'name', name,
  'status', status, 'kind', NULL, 'duration_ms', duration_ms,
  'cost_usd', cost_usd, 'created', started_at, 'span_attributes', attributes_json
) AS payload FROM traces
WHERE project_id = nullif(current_setting('datool.alert_project_id', true), '')
  AND started_at_ms >= nullif(current_setting('datool.alert_window_start', true), '')::double precision
  AND started_at_ms <= nullif(current_setting('datool.alert_window_end', true), '')::double precision
UNION ALL
SELECT started_at_ms, jsonb_build_object(
  'id', id, 'trace_id', trace_id, 'resource', 'span', 'name', name,
  'status', status, 'kind', kind, 'duration_ms', duration_ms,
  'cost_usd', cost_usd, 'created', started_at, 'span_attributes', attributes_json
) AS payload FROM spans
WHERE project_id = nullif(current_setting('datool.alert_project_id', true), '')
  AND started_at_ms >= nullif(current_setting('datool.alert_window_start', true), '')::double precision
  AND started_at_ms <= nullif(current_setting('datool.alert_window_end', true), '')::double precision;

REVOKE ALL ON alert_evaluation_logs FROM PUBLIC;
