ALTER TABLE datasets
  ADD COLUMN version_id text NOT NULL DEFAULT gen_random_uuid()::text,
  ADD COLUMN revision integer NOT NULL DEFAULT 0;
ALTER TABLE dataset_items
  ADD COLUMN version_id text NOT NULL DEFAULT gen_random_uuid()::text;

-- Store only the changed document, not a full dataset copy on every edit.
CREATE TABLE dataset_versions (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  dataset_id text NOT NULL,
  revision integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('item_created', 'item_updated', 'item_deleted', 'settings_updated')),
  item_id text,
  before_value jsonb,
  after_value jsonb,
  created_at text NOT NULL,
  FOREIGN KEY (project_id, dataset_id) REFERENCES datasets(project_id, id) ON DELETE CASCADE,
  UNIQUE (project_id, dataset_id, revision)
);
CREATE INDEX dataset_versions_page_idx ON dataset_versions(project_id, dataset_id, revision DESC, id);

CREATE FUNCTION dataset_item_document(item dataset_items) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'input', item.input_json::jsonb,
    'expectedOutput', item.expected_output_json::jsonb,
    'metadata', item.metadata_json::jsonb,
    'sourceTraceId', item.source_trace_id
  );
$$;

CREATE FUNCTION dataset_item_set_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF dataset_item_document(OLD) IS DISTINCT FROM dataset_item_document(NEW) THEN
    NEW.version_id := gen_random_uuid()::text;
  ELSE
    NEW.version_id := OLD.version_id;
    NEW.updated_at := OLD.updated_at;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER dataset_item_set_version BEFORE UPDATE ON dataset_items
  FOR EACH ROW EXECUTE FUNCTION dataset_item_set_version();

CREATE FUNCTION dataset_item_record_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item dataset_items;
  version text;
  sequence_number integer;
  previous_value jsonb;
  next_value jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.version_id = OLD.version_id THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' THEN
    item := OLD;
    version := gen_random_uuid()::text;
  ELSE
    item := NEW;
    version := NEW.version_id;
    next_value := dataset_item_document(NEW);
  END IF;
  IF TG_OP <> 'INSERT' THEN previous_value := dataset_item_document(OLD); END IF;

  UPDATE datasets SET version_id = version, revision = revision + 1
    WHERE project_id = item.project_id AND id = item.dataset_id
    RETURNING revision INTO sequence_number;
  -- A cascading dataset deletion removes the journal as well.
  IF sequence_number IS NULL THEN RETURN NULL; END IF;
  INSERT INTO dataset_versions(id, project_id, dataset_id, revision, kind, item_id, before_value, after_value, created_at)
    VALUES (version, item.project_id, item.dataset_id, sequence_number,
      CASE TG_OP WHEN 'INSERT' THEN 'item_created' WHEN 'UPDATE' THEN 'item_updated' ELSE 'item_deleted' END,
      item.id, previous_value, next_value, to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  RETURN NULL;
END;
$$;
CREATE TRIGGER dataset_item_record_version AFTER INSERT OR UPDATE OR DELETE ON dataset_items
  FOR EACH ROW EXECUTE FUNCTION dataset_item_record_version();

CREATE FUNCTION dataset_settings_document(item datasets) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('name', item.name, 'description', item.description,
    'metadata', item.metadata_json::jsonb, 'fieldSchemas', item.field_schemas_json::jsonb);
$$;
CREATE FUNCTION dataset_settings_record_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF dataset_settings_document(OLD) IS DISTINCT FROM dataset_settings_document(NEW) THEN
    NEW.version_id := gen_random_uuid()::text;
    NEW.revision := OLD.revision + 1;
    INSERT INTO dataset_versions(id, project_id, dataset_id, revision, kind, before_value, after_value, created_at)
      VALUES (NEW.version_id, NEW.project_id, NEW.id, NEW.revision, 'settings_updated',
        dataset_settings_document(OLD), dataset_settings_document(NEW),
        to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER dataset_settings_record_version BEFORE UPDATE ON datasets
  FOR EACH ROW EXECUTE FUNCTION dataset_settings_record_version();
