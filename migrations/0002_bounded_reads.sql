-- Fail promptly rather than waiting behind a busy application transaction.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

-- Group identity is explicit; historical JSON attributes are not reclassified.
ALTER TABLE traces ADD COLUMN IF NOT EXISTS group_type text;
ALTER TABLE traces ADD COLUMN IF NOT EXISTS group_name text;
ALTER TABLE traces ADD COLUMN IF NOT EXISTS group_version text;
ALTER TABLE spans ADD COLUMN IF NOT EXISTS group_name text;
ALTER TABLE spans ADD COLUMN IF NOT EXISTS group_version text;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'traces'::regclass AND conname = 'trace_group_valid') THEN
 ALTER TABLE traces ADD CONSTRAINT trace_group_valid CHECK (
  (group_type IS NULL AND group_name IS NULL AND group_version IS NULL) OR
  (group_type IN ('agent', 'workflow') AND group_type IS NOT NULL AND group_name IS NOT NULL
   AND length(btrim(group_name)) BETWEEN 1 AND 200 AND group_name = btrim(group_name)
   AND (group_version IS NULL OR (length(btrim(group_version)) BETWEEN 1 AND 200 AND group_version = btrim(group_version))))
);
 END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'spans'::regclass AND conname = 'span_group_valid') THEN
 ALTER TABLE spans ADD CONSTRAINT span_group_valid CHECK (
  (group_name IS NULL AND group_version IS NULL) OR
  (kind IN ('agent', 'workflow') AND group_name IS NOT NULL
   AND length(btrim(group_name)) BETWEEN 1 AND 200 AND group_name = btrim(group_name)
   AND (group_version IS NULL OR (length(btrim(group_version)) BETWEEN 1 AND 200 AND group_version = btrim(group_version))))
);
 END IF;
END $$;
CREATE OR REPLACE FUNCTION datool_trace_group_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.group_type, NEW.group_name, NEW.group_version) IS DISTINCT FROM (OLD.group_type, OLD.group_name, OLD.group_version) THEN
   RAISE EXCEPTION 'Invocation group cannot change after creation';
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trace_group_immutable BEFORE UPDATE ON traces FOR EACH ROW EXECUTE FUNCTION datool_trace_group_immutable();
CREATE OR REPLACE FUNCTION datool_span_group_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.group_name, NEW.group_version) IS DISTINCT FROM (OLD.group_name, OLD.group_version)
    OR (OLD.group_name IS NOT NULL AND NEW.kind IS DISTINCT FROM OLD.kind) THEN
   RAISE EXCEPTION 'Invocation group cannot change after creation';
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER span_group_immutable BEFORE UPDATE ON spans FOR EACH ROW EXECUTE FUNCTION datool_span_group_immutable();
CREATE INDEX IF NOT EXISTS traces_project_group_time_idx ON traces(project_id, group_type, started_at_ms) WHERE group_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS traces_project_group_name_time_idx ON traces(project_id, group_type, group_name, started_at_ms) WHERE group_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS spans_project_group_time_idx ON spans(project_id, kind, started_at_ms) WHERE group_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS spans_project_group_name_time_idx ON spans(project_id, kind, group_name, started_at_ms) WHERE group_name IS NOT NULL;
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS created_at_ms double precision;
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS event_at_ms double precision;
CREATE OR REPLACE FUNCTION datool_sync_run_instant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 NEW.created_at_ms := datool_timestamp_ms(NEW.created_at); RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION datool_sync_result_instant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 NEW.event_at_ms := datool_timestamp_ms(coalesce(NEW.completed_at, NEW.created_at)); RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER eval_run_instant BEFORE INSERT OR UPDATE ON eval_runs FOR EACH ROW EXECUTE FUNCTION datool_sync_run_instant();
CREATE OR REPLACE TRIGGER eval_result_instant BEFORE INSERT OR UPDATE ON eval_results FOR EACH ROW EXECUTE FUNCTION datool_sync_result_instant();
CREATE INDEX IF NOT EXISTS eval_runs_project_time_idx ON eval_runs(project_id, created_at_ms);
CREATE INDEX IF NOT EXISTS eval_results_project_time_idx ON eval_results(project_id, event_at_ms);
CREATE INDEX IF NOT EXISTS sessions_project_page_idx ON sessions(project_id, updated_at, id);
CREATE INDEX IF NOT EXISTS datasets_project_page_idx ON datasets(project_id, updated_at, id);
CREATE INDEX IF NOT EXISTS eval_runs_project_page_idx ON eval_runs(project_id, created_at, id);
CREATE INDEX IF NOT EXISTS dataset_items_project_page_idx ON dataset_items(project_id, dataset_id, created_at, id);
