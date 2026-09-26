-- Analytical facts are computed once at write time. Existing installations of
-- 0001 still have text attributes, so complete the storage conversion here too.
CREATE FUNCTION datool_number(doc jsonb, key text, whole boolean DEFAULT false)
RETURNS double precision LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT CASE WHEN jsonb_typeof(doc->key)='number' THEN
   CASE WHEN (doc->>key)::numeric BETWEEN 0 AND
     CASE WHEN whole THEN 9007199254740991::numeric ELSE 1.7976931348623157e308::numeric END
     AND (NOT whole OR trunc((doc->>key)::numeric)=(doc->>key)::numeric)
   THEN (doc->>key)::double precision END END
$$;
CREATE FUNCTION datool_cost(doc jsonb) RETURNS double precision LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT CASE WHEN coalesce(doc->>'cost.status','') NOT IN ('missing','partial') THEN datool_number(doc,'cost.usd') END
$$;
CREATE FUNCTION datool_breakdown(doc jsonb, key text) RETURNS double precision LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT CASE WHEN datool_cost(doc) IS NOT NULL THEN datool_number(
   CASE WHEN jsonb_typeof(doc->'cost.breakdown')='object' THEN doc->'cost.breakdown'
     WHEN pg_input_is_valid(doc->>'cost.breakdown','jsonb') THEN (doc->>'cost.breakdown')::jsonb ELSE '{}'::jsonb END,key) END
$$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['traces','spans'] LOOP
 EXECUTE format('ALTER TABLE %I
 ALTER COLUMN attributes_json DROP DEFAULT,
 ALTER COLUMN attributes_json TYPE jsonb USING attributes_json::jsonb,
 ALTER COLUMN attributes_json SET DEFAULT ''{}''::jsonb',t);
 EXECUTE format('ALTER TABLE %I
 ADD COLUMN duration_ms double precision GENERATED ALWAYS AS (CASE WHEN status IN (''completed'',''errored'',''cancelled'') AND ended_at_ms >= started_at_ms THEN ended_at_ms-started_at_ms END) STORED,
 ADD COLUMN cost_usd double precision GENERATED ALWAYS AS (datool_cost(attributes_json)) STORED,
 ADD COLUMN reported_cost_usd double precision GENERATED ALWAYS AS (datool_number(attributes_json,''cost.usd'')) STORED,
 ADD COLUMN cost_status text GENERATED ALWAYS AS (attributes_json->>''cost.status'') STORED,
 ADD COLUMN cost_present boolean GENERATED ALWAYS AS (attributes_json ? ''cost.usd'') STORED,
 ADD COLUMN input_cost_usd double precision GENERATED ALWAYS AS (datool_breakdown(attributes_json,''inputUSD'')) STORED,
 ADD COLUMN output_cost_usd double precision GENERATED ALWAYS AS (datool_breakdown(attributes_json,''outputUSD'')) STORED,
 ADD COLUMN cache_read_cost_usd double precision GENERATED ALWAYS AS (datool_breakdown(attributes_json,''cacheReadsUSD'')) STORED,
 ADD COLUMN cache_write_cost_usd double precision GENERATED ALWAYS AS (datool_breakdown(attributes_json,''cacheWritesUSD'')) STORED,
 ADD COLUMN input_tokens double precision GENERATED ALWAYS AS (coalesce(datool_number(attributes_json,''usage.input_tokens'',true),datool_number(attributes_json,''gen_ai.usage.input_tokens'',true),datool_number(attributes_json,''ai.usage.inputTokens'',true))) STORED,
 ADD COLUMN output_tokens double precision GENERATED ALWAYS AS (coalesce(datool_number(attributes_json,''usage.output_tokens'',true),datool_number(attributes_json,''gen_ai.usage.output_tokens'',true),datool_number(attributes_json,''ai.usage.outputTokens'',true))) STORED,
 ADD COLUMN reported_total_tokens double precision GENERATED ALWAYS AS (coalesce(datool_number(attributes_json,''usage.total_tokens'',true),datool_number(attributes_json,''ai.usage.totalTokens'',true))) STORED,
 ADD COLUMN cached_tokens double precision GENERATED ALWAYS AS (coalesce(datool_number(attributes_json,''usage.cache_read_tokens'',true),datool_number(attributes_json,''gen_ai.usage.cache_read.input_tokens'',true),datool_number(attributes_json,''ai.usage.inputTokenDetails.cacheReadTokens'',true),datool_number(attributes_json,''ai.usage.cachedInputTokens'',true))) STORED,
 ADD COLUMN written_tokens double precision GENERATED ALWAYS AS (coalesce(datool_number(attributes_json,''usage.cache_write_tokens'',true),datool_number(attributes_json,''gen_ai.usage.cache_creation.input_tokens'',true))) STORED,
 ADD COLUMN ttft_ms double precision GENERATED ALWAYS AS (coalesce(datool_number(attributes_json,''ttft.ms''),datool_number(attributes_json,''latency.ttft_ms''),datool_number(attributes_json,''gen_ai.latency.time_to_first_token'')*1000)) STORED',t);
 EXECUTE format('CREATE INDEX %I ON %I USING gin(attributes_json jsonb_path_ops)',t||'_attributes_gin_idx',t);
 END LOOP;
END $$;
CREATE INDEX traces_project_instant_page_idx ON traces(project_id,started_at_ms,id);
CREATE INDEX traces_project_session_instant_page_idx ON traces(project_id,session_id,started_at_ms,id);

-- Each explicit invocation has its own membership. Listing traces deduplicates
-- trace IDs, while invocation metrics retain each separately grouped child.
CREATE TABLE trace_group_memberships (
 project_id text NOT NULL, trace_id text NOT NULL, source text NOT NULL CHECK(source IN ('trace','span')),
 source_id text NOT NULL, group_type text NOT NULL, group_name text NOT NULL, group_version text,
 trace_started_at_ms double precision,
 PRIMARY KEY(project_id,source,source_id),
 FOREIGN KEY(project_id,trace_id) REFERENCES traces(project_id,id) ON DELETE CASCADE
);
CREATE INDEX trace_groups_name_page_idx ON trace_group_memberships(project_id,group_type,group_name,trace_started_at_ms,trace_id);
CREATE INDEX trace_groups_version_page_idx ON trace_group_memberships(project_id,group_type,group_name,group_version,trace_started_at_ms,trace_id);
CREATE INDEX trace_groups_type_page_idx ON trace_group_memberships(project_id,group_type,trace_started_at_ms,trace_id);
CREATE INDEX trace_groups_trace_idx ON trace_group_memberships(project_id,trace_id);
CREATE FUNCTION datool_trace_membership() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' AND NEW.started_at_ms IS DISTINCT FROM OLD.started_at_ms THEN
   UPDATE trace_group_memberships SET trace_started_at_ms=NEW.started_at_ms WHERE project_id=NEW.project_id AND trace_id=NEW.id;
 END IF;
 IF NEW.group_name IS NOT NULL THEN
   INSERT INTO trace_group_memberships VALUES(NEW.project_id,NEW.id,'trace',NEW.id,NEW.group_type,NEW.group_name,NEW.group_version,NEW.started_at_ms)
   ON CONFLICT(project_id,source,source_id) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trace_membership AFTER INSERT OR UPDATE ON traces FOR EACH ROW EXECUTE FUNCTION datool_trace_membership();
CREATE FUNCTION datool_span_membership() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN
   DELETE FROM trace_group_memberships WHERE project_id=OLD.project_id AND source='span' AND source_id=OLD.id;
   RETURN OLD;
 END IF;
 IF NEW.group_name IS NOT NULL THEN
   INSERT INTO trace_group_memberships
   SELECT NEW.project_id,NEW.trace_id,'span',NEW.id,NEW.kind,NEW.group_name,NEW.group_version,started_at_ms
   FROM traces WHERE project_id=NEW.project_id AND id=NEW.trace_id
   ON CONFLICT(project_id,source,source_id) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER span_membership AFTER INSERT OR DELETE ON spans FOR EACH ROW EXECUTE FUNCTION datool_span_membership();

-- Cost traversal only visits invocations without an inclusive report.
CREATE INDEX traces_group_unreported_cost_idx ON traces(project_id,group_type,group_name,started_at_ms) WHERE group_name IS NOT NULL AND reported_cost_usd IS NULL;
CREATE INDEX spans_group_unreported_cost_idx ON spans(project_id,kind,group_name,started_at_ms) WHERE group_name IS NOT NULL AND reported_cost_usd IS NULL;
