-- Transactionally maintained summaries for additive invocation metrics. Exact
-- percentiles, cost trees, ID filters and partial-hour windows use raw facts.
CREATE TABLE invocation_hourly_stats (
 project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
 kind text NOT NULL, group_name text NOT NULL, group_version text,
 source text NOT NULL, status text NOT NULL, bucket_ms double precision NOT NULL,
 row_count bigint NOT NULL,
 duration_count bigint NOT NULL, duration_sum numeric NOT NULL
);
CREATE UNIQUE INDEX invocation_hourly_key ON invocation_hourly_stats
 (project_id,kind,group_name,group_version,source,status,bucket_ms) NULLS NOT DISTINCT;
CREATE INDEX invocation_hourly_window_idx ON invocation_hourly_stats(project_id,kind,bucket_ms);

-- Deltas can be negative before ON CONFLICT applies them; validate the stored
-- row after the upsert, rather than rejecting the incoming subtraction.
CREATE FUNCTION datool_check_invocation_summary() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.row_count < 0 OR NEW.duration_count < 0 OR NEW.duration_count > NEW.row_count OR NEW.duration_sum < 0 THEN
   RAISE EXCEPTION 'Invalid invocation summary counters' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER invocation_summary_valid AFTER INSERT OR UPDATE ON invocation_hourly_stats
 DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION datool_check_invocation_summary();

CREATE INDEX invocation_hourly_empty_idx ON invocation_hourly_stats(project_id) WHERE row_count=0;

CREATE FUNCTION datool_invocation_summary() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changes text; projection text; BEGIN
 projection := 'SELECT project_id,%I AS kind,group_name,group_version,%L::text AS source,status,
 floor(started_at_ms/3600000)*3600000 AS bucket_ms,%s::bigint AS weight,
 CASE WHEN status IN (''completed'',''errored'') AND duration_ms IS NOT NULL THEN %s ELSE 0 END::bigint AS samples,
 CASE WHEN status IN (''completed'',''errored'') THEN coalesce(duration_ms,0)::numeric * %s ELSE 0 END AS duration
 FROM %I WHERE group_name IS NOT NULL AND started_at_ms IS NOT NULL';
 IF TG_OP='INSERT' THEN changes := format(projection,TG_ARGV[1],TG_ARGV[0],1,1,1,'new_invocations');
 ELSIF TG_OP='DELETE' THEN changes := format(projection,TG_ARGV[1],TG_ARGV[0],-1,-1,-1,'old_invocations');
 ELSE changes := format(projection,TG_ARGV[1],TG_ARGV[0],1,1,1,'new_invocations') || ' UNION ALL ' || format(projection,TG_ARGV[1],TG_ARGV[0],-1,-1,-1,'old_invocations');
 END IF;
 -- Ignore project cascades: their summary rows disappear through the FK.
 EXECUTE 'INSERT INTO invocation_hourly_stats AS stored
 SELECT delta.project_id,kind,group_name,group_version,source,status,bucket_ms,sum(weight),sum(samples),sum(duration)
 FROM (' || changes || ') delta JOIN project ON project.id=delta.project_id
 GROUP BY delta.project_id,kind,group_name,group_version,source,status,bucket_ms
 HAVING sum(weight)<>0 OR sum(samples)<>0 OR sum(duration)<>0
 ORDER BY delta.project_id,kind,group_name,group_version,source,status,bucket_ms
 ON CONFLICT(project_id,kind,group_name,group_version,source,status,bucket_ms) DO UPDATE SET
 row_count=stored.row_count+excluded.row_count,
 duration_count=stored.duration_count+excluded.duration_count,
 duration_sum=stored.duration_sum+excluded.duration_sum';
 EXECUTE 'DELETE FROM invocation_hourly_stats WHERE row_count=0 AND project_id IN (SELECT project_id FROM (' || changes || ') changed)';
 RETURN NULL;
END $$;
CREATE TRIGGER traces_summary_insert AFTER INSERT ON traces REFERENCING NEW TABLE AS new_invocations
 FOR EACH STATEMENT EXECUTE FUNCTION datool_invocation_summary('trace','group_type');
CREATE TRIGGER traces_summary_update AFTER UPDATE ON traces REFERENCING OLD TABLE AS old_invocations NEW TABLE AS new_invocations
 FOR EACH STATEMENT EXECUTE FUNCTION datool_invocation_summary('trace','group_type');
CREATE TRIGGER traces_summary_delete AFTER DELETE ON traces REFERENCING OLD TABLE AS old_invocations
 FOR EACH STATEMENT EXECUTE FUNCTION datool_invocation_summary('trace','group_type');
CREATE TRIGGER spans_summary_insert AFTER INSERT ON spans REFERENCING NEW TABLE AS new_invocations
 FOR EACH STATEMENT EXECUTE FUNCTION datool_invocation_summary('span','kind');
CREATE TRIGGER spans_summary_update AFTER UPDATE ON spans REFERENCING OLD TABLE AS old_invocations NEW TABLE AS new_invocations
 FOR EACH STATEMENT EXECUTE FUNCTION datool_invocation_summary('span','kind');
CREATE TRIGGER spans_summary_delete AFTER DELETE ON spans REFERENCING OLD TABLE AS old_invocations
 FOR EACH STATEMENT EXECUTE FUNCTION datool_invocation_summary('span','kind');
