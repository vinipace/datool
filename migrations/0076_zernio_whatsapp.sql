-- A Zernio profile is dedicated to one Datool channel. Only a verified account
-- returned by Zernio may be bound to it; callback query parameters are hints.
CREATE TABLE build_zernio_whatsapp (
  connection_id uuid PRIMARY KEY,
  project_id text NOT NULL,
  profile_id text NOT NULL UNIQUE,
  account_id text UNIQUE,
  mode text NOT NULL CHECK (mode IN ('cloud','coexistence')),
  display_phone_number text,
  signup_id uuid,
  signup_expires_at timestamptz,
  connected_at timestamptz,
  FOREIGN KEY (project_id, connection_id)
    REFERENCES build_channel_connection(project_id,id) ON DELETE CASCADE
);

ALTER TABLE build_channel_connection DROP CONSTRAINT build_whatsapp_provider;
ALTER TABLE build_channel_connection ADD CONSTRAINT build_whatsapp_provider
  CHECK (channel <> 'whatsapp' OR config_json->>'provider' IN ('meta','evolution','zernio'));

-- Prevent one WhatsApp number from routing simultaneously through two providers.
CREATE FUNCTION datool_zernio_number_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE number text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM build_whatsapp_number_binding WHERE connection_id=OLD.connection_id;
    RETURN OLD;
  END IF;
  IF NEW.account_id IS NULL THEN
    DELETE FROM build_whatsapp_number_binding WHERE connection_id=NEW.connection_id;
  ELSE
    number := regexp_replace(NEW.display_phone_number, '[^0-9]', '', 'g');
    IF number !~ '^[1-9][0-9]{6,19}$' THEN RAISE EXCEPTION 'Invalid WhatsApp number binding'; END IF;
    INSERT INTO build_whatsapp_number_binding(phone,connection_id) VALUES(number,NEW.connection_id)
    ON CONFLICT(connection_id) DO UPDATE SET phone=EXCLUDED.phone;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER build_zernio_number_binding AFTER INSERT OR UPDATE OR DELETE ON build_zernio_whatsapp
  FOR EACH ROW EXECUTE FUNCTION datool_zernio_number_binding();
