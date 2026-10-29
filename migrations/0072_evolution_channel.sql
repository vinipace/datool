-- Evolution is an explicit provider; existing WhatsApp connections remain Meta.
UPDATE build_channel_connection SET config_json=config_json || '{"provider":"meta"}'::jsonb WHERE channel='whatsapp' AND NOT config_json ? 'provider';
ALTER TABLE build_channel_connection ADD CONSTRAINT build_whatsapp_provider CHECK (channel <> 'whatsapp' OR config_json->>'provider' IN ('meta','evolution'));
CREATE TABLE build_evolution_instance (
 connection_id uuid PRIMARY KEY,
 project_id text NOT NULL,
 instance_name text NOT NULL UNIQUE,
 server_id text NOT NULL DEFAULT 'primary',
 state text NOT NULL DEFAULT 'connecting' CHECK(state IN ('connecting','open','close','cleanup_pending')),
 desired_state text NOT NULL DEFAULT 'active' CHECK(desired_state IN ('active','paused','disconnected')),
 phone text UNIQUE,
 accepted_by text NOT NULL,
 accepted_version text NOT NULL,
 accepted_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz NOT NULL DEFAULT now(),
 checked_at timestamptz,
 last_send_at timestamptz,
 FOREIGN KEY(project_id,connection_id) REFERENCES build_channel_connection(project_id,id) ON DELETE CASCADE
);
-- Shared ownership prevents the same phone being connected through two providers.
CREATE TABLE build_whatsapp_number_binding (
 phone text PRIMARY KEY CHECK(phone ~ '^[1-9][0-9]{6,19}$'),
 connection_id uuid NOT NULL UNIQUE REFERENCES build_channel_connection(id) ON DELETE CASCADE
);
CREATE FUNCTION datool_whatsapp_number_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE number text;
BEGIN
 IF TG_OP='DELETE' THEN
  DELETE FROM build_whatsapp_number_binding WHERE connection_id=OLD.connection_id;
  RETURN OLD;
 END IF;
 IF TG_TABLE_NAME='build_whatsapp_account' THEN
  number := regexp_replace(NEW.display_phone_number, '[^0-9]', '', 'g');
 ELSE
  number := NEW.phone;
 END IF;
 IF number IS NOT NULL AND number <> '' THEN
  IF number !~ '^[1-9][0-9]{6,19}$' THEN RAISE EXCEPTION 'Invalid WhatsApp number binding'; END IF;
  INSERT INTO build_whatsapp_number_binding(phone,connection_id) VALUES(number,NEW.connection_id)
  ON CONFLICT(connection_id) DO UPDATE SET phone=EXCLUDED.phone;
 END IF;
 RETURN NEW;
END $$;
INSERT INTO build_whatsapp_number_binding(phone,connection_id)
 SELECT regexp_replace(display_phone_number,'[^0-9]','','g'),connection_id FROM build_whatsapp_account;
CREATE TRIGGER build_meta_number_binding AFTER INSERT OR UPDATE OR DELETE ON build_whatsapp_account FOR EACH ROW EXECUTE FUNCTION datool_whatsapp_number_binding();
CREATE TRIGGER build_evolution_number_binding AFTER INSERT OR UPDATE OR DELETE ON build_evolution_instance FOR EACH ROW EXECUTE FUNCTION datool_whatsapp_number_binding();
