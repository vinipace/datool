-- Existing provider volumes retain their identity and contents.
CREATE TABLE build_storage_connections (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('s3','gcs')),
  config_json jsonb NOT NULL,
  encrypted_credentials text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, id)
);
ALTER TABLE build_drives DROP CONSTRAINT build_drives_provider_check;
ALTER TABLE build_drives ADD CONSTRAINT build_drives_provider_check CHECK (provider IN ('datool','local','modal','s3','gcs'));
ALTER TABLE build_drives ADD COLUMN storage_connection_id uuid,
  ADD COLUMN head_revision uuid,
  ADD COLUMN sync_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN sync_hydrating boolean NOT NULL DEFAULT false,
  ADD COLUMN sync_compute_provider text CHECK (sync_compute_provider IN ('datool','local','modal')),
  ADD CONSTRAINT build_drives_storage_connection_fk FOREIGN KEY(project_id,storage_connection_id)
    REFERENCES build_storage_connections(project_id,id),
  ADD CONSTRAINT build_drives_storage_kind_check CHECK ((provider IN ('s3','gcs')) = (storage_connection_id IS NOT NULL));
CREATE TABLE build_drive_versions (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  drive_id uuid NOT NULL,
  manifest_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, drive_id, id),
  FOREIGN KEY(project_id,drive_id) REFERENCES build_drives(project_id,id) ON DELETE CASCADE
);
ALTER TABLE build_drives ADD CONSTRAINT build_drives_head_revision_fk
  FOREIGN KEY(project_id,id,head_revision) REFERENCES build_drive_versions(project_id,drive_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX build_drive_versions_page_idx ON build_drive_versions(project_id,drive_id,created_at DESC,id);
