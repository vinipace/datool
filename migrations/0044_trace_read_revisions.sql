-- Bounded change tokens per project. Partition by trace identity so concurrent
-- writers of unrelated traces do not serialize on a single project-wide row.
-- Redis exposes one aggregate project version; these rows are the durable source.
CREATE TABLE trace_read_revisions (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  bucket integer NOT NULL CHECK (bucket >= 0 AND bucket < 64),
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY (project_id, bucket)
);

CREATE FUNCTION datool_bump_trace_read_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed text;
BEGIN
  -- Project and trace identity are selected directly; do not copy JSON payloads.
  IF TG_OP = 'INSERT' THEN
    changed := format('SELECT project_id, %I AS trace_id FROM new_rows', TG_ARGV[0]);
  ELSIF TG_OP = 'UPDATE' THEN
    changed := format('SELECT project_id, %I AS trace_id FROM new_rows UNION SELECT project_id, %I AS trace_id FROM old_rows', TG_ARGV[0], TG_ARGV[0]);
  ELSE
    changed := format('SELECT project_id, %I AS trace_id FROM old_rows', TG_ARGV[0]);
  END IF;
  EXECUTE format($query$
    INSERT INTO trace_read_revisions (project_id, bucket)
      SELECT p.id, ((hashtextextended(r.trace_id, 0) & 2147483647) %% 64)::integer AS bucket
      FROM project p JOIN (%s) r ON r.project_id = p.id
      GROUP BY p.id, bucket ORDER BY p.id, bucket
      ON CONFLICT (project_id, bucket) DO UPDATE SET revision = gen_random_uuid()
  $query$, changed);
  RETURN NULL;
END;
$$;

DO $$
DECLARE relation text; trace_column text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['traces', 'spans'] LOOP
    trace_column := CASE WHEN relation = 'spans' THEN 'trace_id' ELSE 'id' END;
    EXECUTE format('CREATE TRIGGER trace_read_insert AFTER INSERT ON %I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION datool_bump_trace_read_revision(%L)', relation, trace_column);
    EXECUTE format('CREATE TRIGGER trace_read_update AFTER UPDATE ON %I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION datool_bump_trace_read_revision(%L)', relation, trace_column);
    EXECUTE format('CREATE TRIGGER trace_read_delete AFTER DELETE ON %I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION datool_bump_trace_read_revision(%L)', relation, trace_column);
  END LOOP;
END;
$$;
