-- Canonical Page Views / Custom Fields / Object Views retain their original IDs.
ALTER TABLE custom_fields ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE custom_fields ADD COLUMN IF NOT EXISTS created_at text NOT NULL DEFAULT (now()::text);
ALTER TABLE custom_fields ADD COLUMN IF NOT EXISTS updated_at text NOT NULL DEFAULT (now()::text);
ALTER TABLE react_views ADD COLUMN IF NOT EXISTS object_types jsonb NOT NULL DEFAULT '["trace","dataset-item"]';
ALTER TABLE react_views ADD COLUMN IF NOT EXISTS input_contract text NOT NULL DEFAULT 'legacy-trace';
ALTER TABLE react_views ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS view_resource_versions (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('page-view','custom-field','object-view')),
  resource_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  definition jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, kind, resource_id, revision)
);
CREATE TABLE IF NOT EXISTS view_preferences (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  principal_id text NOT NULL,
  scope text NOT NULL,
  value jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, principal_id, scope)
);

-- Serialize dependency checks with every writer, including compatibility APIs.
CREATE FUNCTION lock_view_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(CASE WHEN TG_OP='DELETE' THEN OLD.project_id ELSE NEW.project_id END,732));
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_view_project_lock BEFORE INSERT OR UPDATE OR DELETE ON custom_views FOR EACH ROW EXECUTE FUNCTION lock_view_project();
CREATE TRIGGER a_view_project_lock BEFORE INSERT OR UPDATE OR DELETE ON custom_fields FOR EACH ROW EXECUTE FUNCTION lock_view_project();
CREATE TRIGGER a_view_project_lock BEFORE INSERT OR UPDATE OR DELETE ON react_views FOR EACH ROW EXECUTE FUNCTION lock_view_project();
CREATE FUNCTION pinned_field_references(project text, refs jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(CASE WHEN f.revision IS NULL THEN ref ELSE ref || jsonb_build_object('revision',coalesce((ref->>'revision')::integer,f.revision)) END ORDER BY ordinal),'[]'::jsonb)
  FROM jsonb_array_elements(coalesce(refs,'[]'::jsonb)) WITH ORDINALITY AS r(ref,ordinal)
  LEFT JOIN custom_fields f ON f.project_id=project AND f.id=ref->>'id';
$$;
CREATE FUNCTION pinned_view_definition(project text, kind text, doc jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE refs jsonb; pinned jsonb;
BEGIN
  IF kind='page-view' THEN
    IF doc->'settings' ? 'customFields' THEN
      doc := jsonb_set(doc,'{settings,customFields}',pinned_field_references(project,doc#>'{settings,customFields}'));
    END IF;
    IF doc->'settings' ? 'objectViews' THEN
      SELECT coalesce(jsonb_object_agg(r.key,CASE WHEN v.revision IS NULL THEN r.value ELSE r.value || jsonb_build_object('revision',coalesce((r.value->>'revision')::integer,v.revision)) END),'{}'::jsonb) INTO pinned
      FROM jsonb_each(doc#>'{settings,objectViews}') r LEFT JOIN react_views v ON v.project_id=project AND v.id=r.value->>'id';
      doc := jsonb_set(doc,'{settings,objectViews}',pinned);
    END IF;
  ELSIF kind='object-view' THEN
    doc := jsonb_set(doc,'{customFields}',pinned_field_references(project,doc->'customFields'));
  END IF;
  RETURN doc;
END $$;

-- Preserve field changes from legacy upsert callers in the same revision ledger.
CREATE OR REPLACE FUNCTION version_custom_field() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN NEW.revision := OLD.revision + 1; END IF;
  NEW.updated_at := now()::text;
  RETURN NEW;
END $$;
CREATE TRIGGER custom_field_revision BEFORE UPDATE ON custom_fields FOR EACH ROW EXECUTE FUNCTION version_custom_field();

CREATE OR REPLACE FUNCTION record_view_resource_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc jsonb; resource_kind text;
BEGIN
  resource_kind := TG_ARGV[0];
  doc := to_jsonb(NEW);
  IF resource_kind = 'page-view' THEN
    doc := jsonb_build_object('id', NEW.id, 'name', NEW.name, 'resource', NEW.resource, 'settings', NEW.settings_json::jsonb, 'revision', NEW.revision, 'createdAt', NEW.created_at, 'updatedAt', NEW.updated_at);
  ELSIF resource_kind = 'custom-field' THEN
    doc := NEW.definition_json::jsonb || jsonb_build_object('id', NEW.id, 'revision', NEW.revision, 'createdAt', NEW.created_at, 'updatedAt', NEW.updated_at);
  ELSE
    doc := jsonb_build_object('id', NEW.id, 'projectId', NEW.project_id, 'name', NEW.name, 'description', NEW.description, 'code', NEW.code, 'dataMode', NEW.data_mode, 'requirements', NEW.requirements, 'origin', NEW.origin, 'author', NEW.author, 'objectTypes', NEW.object_types, 'inputContract', NEW.input_contract, 'customFields', NEW.custom_fields, 'revision', NEW.revision, 'createdAt', NEW.created_at, 'updatedAt', NEW.updated_at);
  END IF;
  INSERT INTO view_resource_versions(project_id,kind,resource_id,revision,definition)
  VALUES(NEW.project_id,resource_kind,NEW.id,NEW.revision,pinned_view_definition(NEW.project_id,resource_kind,doc));
  RETURN NEW;
END $$;
CREATE TRIGGER page_view_history AFTER INSERT OR UPDATE ON custom_views FOR EACH ROW EXECUTE FUNCTION record_view_resource_version('page-view');
CREATE TRIGGER custom_field_history AFTER INSERT OR UPDATE ON custom_fields FOR EACH ROW EXECUTE FUNCTION record_view_resource_version('custom-field');
CREATE TRIGGER object_view_history AFTER INSERT OR UPDATE ON react_views FOR EACH ROW EXECUTE FUNCTION record_view_resource_version('object-view');

INSERT INTO view_resource_versions(project_id,kind,resource_id,revision,definition)
SELECT project_id,'page-view',id,revision,jsonb_build_object('id',id,'name',name,'resource',resource,'settings',settings_json::jsonb,'revision',revision,'createdAt',created_at,'updatedAt',updated_at) FROM custom_views;
INSERT INTO view_resource_versions(project_id,kind,resource_id,revision,definition)
SELECT project_id,'custom-field',id,revision,definition_json::jsonb || jsonb_build_object('id',id,'revision',revision,'createdAt',created_at,'updatedAt',updated_at) FROM custom_fields;
INSERT INTO view_resource_versions(project_id,kind,resource_id,revision,definition)
SELECT project_id,'object-view',id,revision,jsonb_build_object('id',id,'projectId',project_id,'name',name,'description',description,'code',code,'dataMode',data_mode,'requirements',requirements,'origin',origin,'author',author,'objectTypes',object_types,'inputContract',input_contract,'customFields',custom_fields,'revision',revision,'createdAt',created_at,'updatedAt',updated_at) FROM react_views;

-- Legacy query records become Page Views, without guessing relationships to layouts.
CREATE OR REPLACE FUNCTION sync_saved_query_page_view() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE query_json jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM custom_views WHERE project_id=OLD.project_id AND id=OLD.id AND settings_json::jsonb ? 'query';
    RETURN OLD;
  END IF;
  query_json := jsonb_build_object('resource',NEW.resource,'columns',NEW.columns_json::jsonb,'filters',NEW.filters_json::jsonb,'sort',NEW.sort_json::jsonb);
  INSERT INTO custom_views(id,project_id,name,resource,settings_json,revision,created_at,updated_at)
  VALUES(NEW.id,NEW.project_id,NEW.name,NEW.resource,jsonb_build_object('schemaVersion',1,'computedColumns','[]'::jsonb,'columnOrder','[]'::jsonb,'columnVisibility','{}'::jsonb,'columnSizing','{}'::jsonb,'view','table','detailsOpen',false,'query',query_json)::text,1,NEW.created_at,NEW.updated_at)
  ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,
    settings_json=(custom_views.settings_json::jsonb || jsonb_build_object('query',query_json))::text,
    revision=custom_views.revision+1,updated_at=NEW.updated_at
  WHERE custom_views.project_id=NEW.project_id AND (custom_views.name IS DISTINCT FROM NEW.name OR custom_views.settings_json::jsonb->'query' IS DISTINCT FROM query_json);
  RETURN NEW;
END $$;
CREATE TRIGGER saved_query_page_view AFTER INSERT OR UPDATE OR DELETE ON saved_views FOR EACH ROW EXECUTE FUNCTION sync_saved_query_page_view();
-- Run the same migration adapter for existing records; saved query timestamps stay intact.
UPDATE saved_views SET name=name;
