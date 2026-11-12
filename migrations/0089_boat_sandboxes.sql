ALTER TABLE project_sandbox_settings DROP CONSTRAINT project_sandbox_settings_supported_providers;
ALTER TABLE project_sandbox_settings ADD CONSTRAINT project_sandbox_settings_supported_providers CHECK (providers - ARRAY['local','vercel','modal','datool','boat']::text[] = '{}'::jsonb);

ALTER TABLE build_agent_sandboxes DROP CONSTRAINT build_agent_sandboxes_provider_check;
ALTER TABLE build_agent_sandboxes ADD CONSTRAINT build_agent_sandboxes_provider_check CHECK (provider IN ('local','modal','datool','boat'));
ALTER TABLE build_drives DROP CONSTRAINT build_drives_sync_compute_provider_check;
ALTER TABLE build_drives ADD CONSTRAINT build_drives_sync_compute_provider_check CHECK (sync_compute_provider IN ('local','modal','datool','boat'));

-- One VM per execution/drive lease, never shared between projects or writers.
-- Persist the allocation receipt before restoring files or starting user code.
CREATE TABLE build_boat_sandboxes (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  native_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  UNIQUE(project_id, id)
);
ALTER TABLE build_drives ADD COLUMN sync_compute_id uuid;
ALTER TABLE build_drives ADD CONSTRAINT build_drives_boat_cache_fk FOREIGN KEY(project_id,sync_compute_id) REFERENCES build_boat_sandboxes(project_id,id);
