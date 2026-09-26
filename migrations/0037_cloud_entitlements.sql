ALTER TABLE organization_billing
  ADD COLUMN plan text CHECK (plan IN ('core', 'pro')),
  ADD COLUMN record_limit integer NOT NULL DEFAULT 0 CHECK (record_limit >= 0),
  ADD COLUMN retention_days integer NOT NULL DEFAULT 90 CHECK (retention_days > 0),
  ADD COLUMN access_until timestamptz,
  ADD COLUMN grace_until timestamptz,
  ADD COLUMN next_payment_attempt timestamptz;
-- Refresh existing subscriptions on first access after the migration.
UPDATE organization_billing SET synced_at=NULL;

CREATE TABLE organization_usage_month (
  organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  traces bigint NOT NULL DEFAULT 0 CHECK (traces >= 0),
  spans bigint NOT NULL DEFAULT 0 CHECK (spans >= 0),
  PRIMARY KEY (organization_id, period_start)
);

-- Retention starts on receipt, including historical imports. Existing data gets
-- a full retention window from rollout; client timestamps cannot extend it.
ALTER TABLE traces ADD COLUMN stored_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX traces_project_stored_idx ON traces(project_id, stored_at, id);
-- Retention also removes payload copies while keeping retry/import tombstones.
CREATE INDEX ingestion_receipts_result_idx ON ingestion_receipts(project_id,(result_json->>'id'));
CREATE INDEX langfuse_import_destination_idx ON langfuse_import_records(project_id,destination_id);

CREATE FUNCTION datool_meter_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  organization_key text;
  entitlement organization_billing%ROWTYPE;
  month_start date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  new_traces integer := CASE WHEN TG_TABLE_NAME='traces' THEN 1 ELSE 0 END;
  new_spans integer := CASE WHEN TG_TABLE_NAME='spans' THEN 1 ELSE 0 END;
  affected integer;
BEGIN
  IF current_setting('datool.billing_enabled', true) IS DISTINCT FROM 'true' THEN
    RETURN NEW;
  END IF;
  SELECT organization_id INTO organization_key FROM project WHERE id=NEW.project_id;
  SELECT * INTO entitlement FROM organization_billing WHERE organization_id=organization_key;
  IF entitlement.plan IS NULL OR entitlement.access_until IS NULL OR
      entitlement.access_until <= now() OR
      entitlement.status NOT IN ('active','trialing','past_due') THEN
    RAISE EXCEPTION USING ERRCODE='P4020', MESSAGE='Cloud subscription required';
  END IF;
  INSERT INTO organization_usage_month(organization_id,period_start,traces,spans)
    VALUES(organization_key,month_start,0,0) ON CONFLICT DO NOTHING;
  UPDATE organization_usage_month SET traces=traces+new_traces, spans=spans+new_spans
    WHERE organization_id=organization_key AND period_start=month_start
      AND traces+spans+1 <= entitlement.record_limit;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected=0 THEN
    RAISE EXCEPTION USING ERRCODE='P4290', MESSAGE='Monthly Cloud record limit reached',
      DETAIL=json_build_object('reason','RECORD_LIMIT_REACHED','limit',entitlement.record_limit,
        'retryAfterSeconds',greatest(1,ceil(extract(epoch FROM
          ((month_start + interval '1 month') AT TIME ZONE 'UTC')-now()))),
        'billingUrl','/billing')::text;
  END IF;
  RETURN NEW;
END $$;
-- AFTER INSERT ignores ON CONFLICT retries. Metering and persistence commit or
-- roll back together, including bulk writes, imports and concurrent workers.
CREATE TRIGGER traces_cloud_usage AFTER INSERT ON traces
  FOR EACH ROW EXECUTE FUNCTION datool_meter_record();
CREATE TRIGGER spans_cloud_usage AFTER INSERT ON spans
  FOR EACH ROW EXECUTE FUNCTION datool_meter_record();
