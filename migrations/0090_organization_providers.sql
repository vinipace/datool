-- Preserve every existing account and immutable credential AAD while moving
-- ownership to the organization. Project bindings contain no secrets.
ALTER TABLE project ADD CONSTRAINT project_organization_identity UNIQUE(organization_id,id);
CREATE TABLE organization_credential_origins (
  project_id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  UNIQUE(organization_id,project_id)
);
INSERT INTO organization_credential_origins SELECT id,organization_id FROM project;

CREATE TABLE organization_provider_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('model','sandbox')),
  provider text NOT NULL,
  name text NOT NULL,
  encrypted_credentials text,
  legacy_project_id text,
  is_default boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((kind='model' AND provider IN ('openai','typesafe-ai','vercel-ai-gateway')) OR
    (kind='sandbox' AND provider IN ('local','datool','modal','vercel','boat'))),
  CHECK(encrypted_credentials IS NOT NULL OR (kind='sandbox' AND provider IN ('local','datool'))),
  FOREIGN KEY(organization_id,legacy_project_id) REFERENCES organization_credential_origins(organization_id,project_id),
  UNIQUE(organization_id,kind,provider,id)
);
CREATE UNIQUE INDEX organization_provider_default ON organization_provider_connections(organization_id,kind,provider) WHERE is_default;
CREATE TABLE project_provider_bindings (
  project_id text NOT NULL,
  organization_id text NOT NULL,
  kind text NOT NULL,
  provider text NOT NULL,
  connection_id uuid NOT NULL,
  PRIMARY KEY(project_id,kind,provider),
  FOREIGN KEY(organization_id,project_id) REFERENCES project(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY(organization_id,kind,provider,connection_id) REFERENCES organization_provider_connections(organization_id,kind,provider,id)
);
INSERT INTO organization_provider_connections(organization_id,kind,provider,name,encrypted_credentials,legacy_project_id,updated_at)
  SELECT p.organization_id,'model',m.provider,p.name,m.encrypted_api_key,p.id,m.updated_at
  FROM project_model_provider m JOIN project p ON p.id=m.project_id;
INSERT INTO organization_provider_connections(organization_id,kind,provider,name,encrypted_credentials,legacy_project_id,updated_at)
  SELECT p.organization_id,'sandbox',entry.key,p.name,entry.value,p.id,s.updated_at
  FROM project_sandbox_settings s JOIN project p ON p.id=s.project_id CROSS JOIN LATERAL jsonb_each_text(s.providers) entry;
INSERT INTO project_provider_bindings SELECT legacy_project_id,organization_id,kind,provider,id FROM organization_provider_connections;
WITH first_connections AS (
  SELECT DISTINCT ON (organization_id,kind,provider) id FROM organization_provider_connections ORDER BY organization_id,kind,provider,updated_at,id
) UPDATE organization_provider_connections SET is_default=true WHERE id IN (SELECT id FROM first_connections);
INSERT INTO organization_provider_connections(organization_id,kind,provider,name,is_default)
  SELECT o.id,'sandbox','local','Local container',true FROM organization o
  WHERE NOT EXISTS(SELECT 1 FROM organization_provider_connections c WHERE c.organization_id=o.id AND c.kind='sandbox' AND c.provider='local');

CREATE TABLE organization_sandbox_settings (
  organization_id text PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
  default_provider text CHECK(default_provider IN ('local','datool','modal','vercel','boat')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO organization_sandbox_settings SELECT id,'local',now() FROM organization;
CREATE TABLE project_sandbox_preferences (
  project_id text PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  default_provider text
);
INSERT INTO project_sandbox_preferences SELECT project_id,default_provider FROM project_sandbox_settings;
DROP TABLE project_model_provider;
DROP TABLE project_sandbox_settings;

ALTER TABLE build_storage_connections DROP CONSTRAINT build_storage_connections_project_id_fkey;
ALTER TABLE build_storage_connections RENAME COLUMN project_id TO legacy_project_id;
ALTER TABLE build_storage_connections ALTER COLUMN legacy_project_id DROP NOT NULL;
ALTER TABLE build_storage_connections ADD COLUMN organization_id text REFERENCES organization(id) ON DELETE CASCADE;
UPDATE build_storage_connections c SET organization_id=p.organization_id FROM project p WHERE p.id=c.legacy_project_id;
ALTER TABLE build_storage_connections ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE build_storage_connections ADD CONSTRAINT storage_credential_origin FOREIGN KEY(organization_id,legacy_project_id) REFERENCES organization_credential_origins(organization_id,project_id);
ALTER TABLE build_storage_connections ADD CONSTRAINT storage_organization_identity UNIQUE(organization_id,id);
ALTER TABLE build_drives DROP CONSTRAINT build_drives_storage_connection_fk;
ALTER TABLE build_drives ADD COLUMN organization_id text;
UPDATE build_drives d SET organization_id=p.organization_id FROM project p WHERE p.id=d.project_id;
ALTER TABLE build_drives ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE build_drives ADD CONSTRAINT build_drives_organization_project FOREIGN KEY(organization_id,project_id) REFERENCES project(organization_id,id) ON DELETE CASCADE;
ALTER TABLE build_drives ADD CONSTRAINT build_drives_storage_connection_fk FOREIGN KEY(organization_id,storage_connection_id) REFERENCES build_storage_connections(organization_id,id);
