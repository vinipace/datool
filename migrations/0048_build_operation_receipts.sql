-- A transport-level replay fence for keyed Build operations. Domain services
-- retain their own transaction/provider receipts; this table stores only the
-- normalized request identity and JSON-safe response, never credentials.
CREATE TABLE build_operation_receipts (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  operation_name text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  input_hash text NOT NULL CHECK (length(input_hash) = 64),
  status text NOT NULL CHECK (status IN ('pending','completed','failed')),
  result_json jsonb,
  error_code text,
  error_message text,
  actor_id text,
  request_key text,
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (project_id, operation_name, idempotency_key),
  CHECK (status <> 'completed' OR result_json IS NOT NULL),
  CHECK (status <> 'failed' OR error_code IS NOT NULL)
);
CREATE INDEX build_operation_receipts_project_updated_idx
  ON build_operation_receipts(project_id, updated_at DESC, id);
