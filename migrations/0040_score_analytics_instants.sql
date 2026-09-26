-- Parse rating timestamps once on writes, retaining original API values.
-- Fail and roll back if a busy table prevents acquisition; do not queue indefinitely.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE scores ADD COLUMN event_at_ms double precision;
ALTER TABLE review_scores ADD COLUMN event_at_ms double precision;
CREATE FUNCTION datool_sync_score_instant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  NEW.event_at_ms := datool_timestamp_ms(NEW.created_at); RETURN NEW;
END $$;
CREATE FUNCTION datool_sync_review_score_instant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  NEW.event_at_ms := datool_timestamp_ms(NEW.updated_at); RETURN NEW;
END $$;
CREATE TRIGGER score_instant BEFORE INSERT OR UPDATE ON scores FOR EACH ROW EXECUTE FUNCTION datool_sync_score_instant();
CREATE TRIGGER review_score_instant BEFORE INSERT OR UPDATE ON review_scores FOR EACH ROW EXECUTE FUNCTION datool_sync_review_score_instant();
UPDATE scores SET event_at_ms = datool_timestamp_ms(created_at);
UPDATE review_scores SET event_at_ms = datool_timestamp_ms(updated_at);
CREATE INDEX scores_project_time_idx ON scores(project_id,event_at_ms);
CREATE INDEX review_scores_project_time_idx ON review_scores(project_id,event_at_ms);
