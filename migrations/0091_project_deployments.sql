CREATE TABLE project_deployments (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  content_hash text NOT NULL,
  bundle_json jsonb NOT NULL,
  tools_json jsonb NOT NULL,
  sandbox_provider text NOT NULL CHECK (sandbox_provider IN ('local','modal','boat','datool')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  UNIQUE(project_id,id)
);
CREATE INDEX project_deployments_history ON project_deployments(project_id,created_at DESC,id);
CREATE TABLE project_deployment_state (
  project_id text PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  organization_id text NOT NULL,
  active_id uuid NOT NULL,
  storage_connection_id uuid,
  FOREIGN KEY(project_id,organization_id) REFERENCES project(id,organization_id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,active_id) REFERENCES project_deployments(project_id,id),
  FOREIGN KEY(storage_connection_id,organization_id) REFERENCES build_storage_connections(id,organization_id) ON DELETE RESTRICT
);
CREATE TABLE project_deployed_agents (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  slug text NOT NULL,
  agent_id text NOT NULL,
  PRIMARY KEY(project_id,slug),
  FOREIGN KEY(project_id,agent_id) REFERENCES build_agents(project_id,id) ON DELETE CASCADE
);
CREATE TABLE project_brain_chunks (
  project_id text NOT NULL,
  deployment_id uuid NOT NULL,
  source_path text NOT NULL,
  title text NOT NULL,
  ordinal integer NOT NULL,
  content text NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple',title || ' ' || content)) STORED,
  PRIMARY KEY(project_id,deployment_id,source_path,ordinal),
  FOREIGN KEY(project_id,deployment_id) REFERENCES project_deployments(project_id,id) ON DELETE CASCADE
);
CREATE INDEX project_brain_search ON project_brain_chunks USING gin(search_vector);
CREATE TABLE project_documents (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  collection text NOT NULL,
  key text NOT NULL,
  value jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,collection,key)
);
CREATE TABLE project_bucket_objects (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  key text NOT NULL,
  object_id uuid NOT NULL,
  size integer NOT NULL CHECK(size BETWEEN 0 AND 1048576),
  content_type text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,key)
);
