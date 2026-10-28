-- Handoff alerts are committed with the source event, then delivered by the
-- Build worker. A provider receipt is acceptance, not proof of a device display.
CREATE TABLE inbox_mobile_devices (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL,
  token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, token),
  UNIQUE (project_id, installation_id)
);
CREATE TABLE inbox_mobile_events (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  conversation_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('handoff','assignment')),
  actor_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expanded_at timestamptz,
  FOREIGN KEY (project_id, conversation_id) REFERENCES build_conversations(project_id,id) ON DELETE CASCADE
);
CREATE INDEX inbox_mobile_events_pending ON inbox_mobile_events(created_at) WHERE expanded_at IS NULL;
CREATE TABLE inbox_mobile_push_jobs (
  id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES inbox_mobile_events(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES inbox_mobile_devices(id) ON DELETE CASCADE,
  token text NOT NULL,
  user_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','receipt','accepted','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  provider_ticket text,
  receipt_expires_at timestamptz,
  last_error text,
  UNIQUE (event_id,device_id)
);
CREATE INDEX inbox_mobile_jobs_due ON inbox_mobile_push_jobs(status,available_at);

CREATE FUNCTION inbox_capture_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_type='handoff' AND NEW.conversation_id IS NOT NULL
    AND coalesce(NEW.payload_json->>'reason','') <> 'Inbox takeover' THEN
    INSERT INTO inbox_mobile_events(id,project_id,conversation_id,kind)
    VALUES (NEW.id,NEW.project_id,NEW.conversation_id,'handoff') ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inbox_mobile_handoff AFTER INSERT ON build_operation_events
FOR EACH ROW WHEN (NEW.event_type='handoff') EXECUTE FUNCTION inbox_capture_handoff();

CREATE FUNCTION inbox_capture_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO inbox_mobile_events(id,project_id,conversation_id,kind,actor_id)
  SELECT NEW.id,NEW.project_id,t.conversation_id,'assignment',NEW.actor_id
  FROM build_inbox_tickets t WHERE t.project_id=NEW.project_id AND t.id=NEW.ticket_id
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER inbox_mobile_assignment AFTER INSERT ON build_ticket_events
FOR EACH ROW WHEN (NEW.event_type='assigned') EXECUTE FUNCTION inbox_capture_assignment();
