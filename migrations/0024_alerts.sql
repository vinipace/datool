CREATE TABLE project_alerts (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  config jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  last_notified_at timestamptz,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  last_evaluated_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, id)
);
CREATE INDEX project_alerts_project_idx ON project_alerts(project_id, created_at);
CREATE INDEX project_alerts_due_idx ON project_alerts(next_check_at)
  WHERE config->>'enabled' = 'true' AND config->>'type' = 'time_window';

CREATE TABLE alert_events (
  id bigserial PRIMARY KEY,
  alert_id text NOT NULL REFERENCES project_alerts(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX alert_events_alert_idx ON alert_events(alert_id, id);

CREATE TABLE alert_deliveries (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  alert_id text NOT NULL,
  alert_name text NOT NULL,
  action text NOT NULL CHECK (action IN ('in_app', 'webhook')),
  webhook_url text,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  FOREIGN KEY(project_id, alert_id) REFERENCES project_alerts(project_id, id) ON DELETE CASCADE
);
CREATE INDEX alert_deliveries_project_idx ON alert_deliveries(project_id, created_at DESC);
CREATE INDEX alert_deliveries_pending_idx ON alert_deliveries(next_attempt_at) WHERE status = 'pending';
CREATE TABLE alert_worker_heartbeat (id text PRIMARY KEY, seen_at timestamptz NOT NULL);

-- The same log projection is used for event matching and time-window queries.
-- Trace/span input and output are deliberately excluded from notifications.
CREATE FUNCTION datool_alert_log(row_data jsonb, resource text) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'id', row_data->'id', 'trace_id', coalesce(row_data->'trace_id', row_data->'id'),
    'resource', resource, 'name', row_data->'name', 'status', row_data->'status',
    'kind', row_data->'kind', 'duration_ms', row_data->'duration_ms',
    'cost_usd', row_data->'cost_usd', 'created', row_data->'started_at',
    'span_attributes', coalesce(row_data->'attributes_json', '{}'::jsonb)
  )
$$;

CREATE FUNCTION datool_enqueue_alert_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE log_payload jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM project_alerts WHERE project_id = NEW.project_id
      AND config->>'enabled' = 'true' AND config->>'type' = 'log_event') THEN
    RETURN NEW;
  END IF;
  log_payload := datool_alert_log(to_jsonb(NEW), TG_ARGV[0]);
  IF TG_OP = 'UPDATE' AND log_payload = datool_alert_log(to_jsonb(OLD), TG_ARGV[0]) THEN
    RETURN NEW;
  END IF;
  INSERT INTO alert_events(alert_id, revision, payload)
    SELECT id, revision, log_payload FROM project_alerts
    WHERE project_id = NEW.project_id AND config->>'enabled' = 'true'
      AND config->>'type' = 'log_event';
  RETURN NEW;
END
$$;
CREATE TRIGGER traces_alert_event AFTER INSERT OR UPDATE ON traces
  FOR EACH ROW EXECUTE FUNCTION datool_enqueue_alert_event('trace');
CREATE TRIGGER spans_alert_event AFTER INSERT OR UPDATE ON spans
  FOR EACH ROW EXECUTE FUNCTION datool_enqueue_alert_event('span');
