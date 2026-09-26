-- Group membership classifies operations without changing their recorded kind.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE spans ADD COLUMN group_type text;
-- Before this migration, kind was the authoritative type for explicit groups.
-- Preserve those memberships without guessing or rewriting operation kinds.
UPDATE spans SET group_type = kind WHERE group_name IS NOT NULL;

ALTER TABLE spans DROP CONSTRAINT span_group_valid;
ALTER TABLE spans ADD CONSTRAINT span_group_valid CHECK (
  (group_type IS NULL AND group_name IS NULL AND group_version IS NULL) OR
  (group_type IS NOT NULL AND group_type IN ('agent', 'workflow') AND group_name IS NOT NULL
    AND length(btrim(group_name)) BETWEEN 1 AND 200 AND group_name = btrim(group_name)
    AND (group_version IS NULL OR (length(btrim(group_version)) BETWEEN 1 AND 200 AND group_version = btrim(group_version))))
);

CREATE OR REPLACE FUNCTION datool_span_group_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF (NEW.group_type, NEW.group_name, NEW.group_version) IS DISTINCT FROM
     (OLD.group_type, OLD.group_name, OLD.group_version) THEN
    RAISE EXCEPTION 'Group membership cannot change after creation';
  END IF;
  RETURN NEW;
END $$;

DROP INDEX spans_project_group_time_idx;
DROP INDEX spans_project_group_name_time_idx;
DROP INDEX spans_group_unreported_cost_idx;
CREATE INDEX spans_project_group_time_idx ON spans(project_id, group_type, started_at_ms) WHERE group_name IS NOT NULL;
CREATE INDEX spans_project_group_name_time_idx ON spans(project_id, group_type, group_name, started_at_ms) WHERE group_name IS NOT NULL;
CREATE INDEX spans_group_unreported_cost_idx ON spans(project_id, group_type, group_name, started_at_ms) WHERE group_name IS NOT NULL AND reported_cost_usd IS NULL;

CREATE OR REPLACE FUNCTION datool_span_membership() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN
    DELETE FROM trace_group_memberships WHERE project_id=OLD.project_id AND source='span' AND source_id=OLD.id;
    RETURN OLD;
  END IF;
  IF NEW.group_name IS NOT NULL THEN
    INSERT INTO trace_group_memberships
    SELECT NEW.project_id,NEW.trace_id,'span',NEW.id,NEW.group_type,NEW.group_name,NEW.group_version,started_at_ms
    FROM traces WHERE project_id=NEW.project_id AND id=NEW.trace_id
    ON CONFLICT(project_id,source,source_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

-- Existing summary rows keep the same group identity. Future deltas read the
-- independent group type, including when an operation's kind is corrected.
DROP TRIGGER spans_summary_insert ON spans;
DROP TRIGGER spans_summary_update ON spans;
DROP TRIGGER spans_summary_delete ON spans;
CREATE TRIGGER spans_summary_insert AFTER INSERT ON spans REFERENCING NEW TABLE AS new_invocations
  FOR EACH STATEMENT EXECUTE FUNCTION datool_invocation_summary('span','group_type');
CREATE TRIGGER spans_summary_update AFTER UPDATE ON spans REFERENCING OLD TABLE AS old_invocations NEW TABLE AS new_invocations
  FOR EACH STATEMENT EXECUTE FUNCTION datool_invocation_summary('span','group_type');
CREATE TRIGGER spans_summary_delete AFTER DELETE ON spans REFERENCING OLD TABLE AS old_invocations
  FOR EACH STATEMENT EXECUTE FUNCTION datool_invocation_summary('span','group_type');
