-- Durable Build catalog. Agent and definition revisions are append-only; the
-- current rows are small pointers used for fast reads and optimistic writes.
CREATE TABLE build_agents (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  description text,
  status text NOT NULL CHECK (status IN ('active','archived')),
  current_revision integer NOT NULL CHECK (current_revision > 0),
  applied_revision integer NOT NULL CHECK (applied_revision > 0),
  current_config_json jsonb NOT NULL,
  applied_config_json jsonb NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  archived_at text,
  UNIQUE (project_id, id),
  UNIQUE (project_id, slug)
);
CREATE INDEX build_agents_project_status_idx ON build_agents(project_id, status, updated_at);

CREATE TABLE build_agent_revisions (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  state text NOT NULL CHECK (state IN ('draft','applied')),
  config_json jsonb NOT NULL,
  created_at text NOT NULL,
  created_by text,
  UNIQUE (project_id, id),
  UNIQUE (project_id, agent_id, revision),
  CONSTRAINT build_agent_revisions_project_agent_fk
    FOREIGN KEY (project_id, agent_id) REFERENCES build_agents(project_id, id) ON DELETE CASCADE
);
CREATE INDEX build_agent_revisions_project_agent_created_idx ON build_agent_revisions(project_id, agent_id, created_at);

CREATE TABLE build_actions (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  slug text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  definition_json jsonb NOT NULL,
  encrypted_headers text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  deleted_at text,
  UNIQUE (project_id, id),
  UNIQUE (project_id, agent_id, slug),
  CONSTRAINT build_actions_project_agent_fk
    FOREIGN KEY (project_id, agent_id) REFERENCES build_agents(project_id, id) ON DELETE CASCADE
);
CREATE INDEX build_actions_project_agent_idx ON build_actions(project_id, agent_id, updated_at);

CREATE TABLE build_action_revisions (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  action_id text NOT NULL,
  agent_id text NOT NULL,
  slug text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  definition_json jsonb NOT NULL,
  encrypted_headers text,
  created_at text NOT NULL,
  created_by text,
  UNIQUE (project_id, id),
  UNIQUE (project_id, action_id, revision),
  CONSTRAINT build_action_revisions_project_action_fk
    FOREIGN KEY (project_id, action_id) REFERENCES build_actions(project_id, id) ON DELETE CASCADE,
  CONSTRAINT build_action_revisions_project_agent_fk
    FOREIGN KEY (project_id, agent_id) REFERENCES build_agents(project_id, id) ON DELETE CASCADE
);

CREATE TABLE build_procedures (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  slug text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  definition_json jsonb NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  deleted_at text,
  UNIQUE (project_id, id),
  UNIQUE (project_id, agent_id, slug),
  CONSTRAINT build_procedures_project_agent_fk
    FOREIGN KEY (project_id, agent_id) REFERENCES build_agents(project_id, id) ON DELETE CASCADE
);
CREATE INDEX build_procedures_project_agent_idx ON build_procedures(project_id, agent_id, updated_at);

CREATE TABLE build_procedure_revisions (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  procedure_id text NOT NULL,
  agent_id text NOT NULL,
  slug text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  definition_json jsonb NOT NULL,
  created_at text NOT NULL,
  created_by text,
  UNIQUE (project_id, id),
  UNIQUE (project_id, procedure_id, revision),
  CONSTRAINT build_procedure_revisions_project_procedure_fk
    FOREIGN KEY (project_id, procedure_id) REFERENCES build_procedures(project_id, id) ON DELETE CASCADE,
  CONSTRAINT build_procedure_revisions_project_agent_fk
    FOREIGN KEY (project_id, agent_id) REFERENCES build_agents(project_id, id) ON DELETE CASCADE
);

CREATE TABLE build_widgets (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  slug text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  definition_json jsonb NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  deleted_at text,
  UNIQUE (project_id, id),
  UNIQUE (project_id, agent_id, slug),
  CONSTRAINT build_widgets_project_agent_fk
    FOREIGN KEY (project_id, agent_id) REFERENCES build_agents(project_id, id) ON DELETE CASCADE
);
CREATE INDEX build_widgets_project_agent_idx ON build_widgets(project_id, agent_id, updated_at);

CREATE TABLE build_widget_revisions (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  widget_id text NOT NULL,
  agent_id text NOT NULL,
  slug text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  definition_json jsonb NOT NULL,
  created_at text NOT NULL,
  created_by text,
  UNIQUE (project_id, id),
  UNIQUE (project_id, widget_id, revision),
  CONSTRAINT build_widget_revisions_project_widget_fk
    FOREIGN KEY (project_id, widget_id) REFERENCES build_widgets(project_id, id) ON DELETE CASCADE,
  CONSTRAINT build_widget_revisions_project_agent_fk
    FOREIGN KEY (project_id, agent_id) REFERENCES build_agents(project_id, id) ON DELETE CASCADE
);

-- Applied revisions pin the exact immutable definition revisions used by the
-- customer runtime. Current definition rows remain editable drafts; deleting
-- a revision referenced by one of these snapshots is rejected by PostgreSQL.
CREATE TABLE build_agent_catalog_snapshots (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  agent_revision integer NOT NULL CHECK (agent_revision > 0),
  created_at text NOT NULL,
  created_by text,
  UNIQUE (project_id, id),
  UNIQUE (project_id, agent_id, agent_revision),
  UNIQUE (project_id, id, agent_id),
  CONSTRAINT build_agent_catalog_snapshots_project_agent_fk
    FOREIGN KEY (project_id, agent_id) REFERENCES build_agents(project_id, id) ON DELETE CASCADE,
  CONSTRAINT build_agent_catalog_snapshots_agent_revision_fk
    FOREIGN KEY (project_id, agent_id, agent_revision)
    REFERENCES build_agent_revisions(project_id, agent_id, revision) ON DELETE RESTRICT
);

CREATE TABLE build_agent_catalog_actions (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  catalog_id text NOT NULL,
  action_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  PRIMARY KEY (project_id, catalog_id, action_id),
  CONSTRAINT build_agent_catalog_actions_snapshot_fk
    FOREIGN KEY (project_id, catalog_id)
    REFERENCES build_agent_catalog_snapshots(project_id, id) ON DELETE CASCADE,
  CONSTRAINT build_agent_catalog_actions_revision_fk
    FOREIGN KEY (project_id, action_id, revision)
    REFERENCES build_action_revisions(project_id, action_id, revision) ON DELETE RESTRICT
);
CREATE INDEX build_agent_catalog_actions_snapshot_idx
  ON build_agent_catalog_actions(project_id, catalog_id);

CREATE TABLE build_agent_catalog_procedures (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  catalog_id text NOT NULL,
  procedure_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  PRIMARY KEY (project_id, catalog_id, procedure_id),
  CONSTRAINT build_agent_catalog_procedures_snapshot_fk
    FOREIGN KEY (project_id, catalog_id)
    REFERENCES build_agent_catalog_snapshots(project_id, id) ON DELETE CASCADE,
  CONSTRAINT build_agent_catalog_procedures_revision_fk
    FOREIGN KEY (project_id, procedure_id, revision)
    REFERENCES build_procedure_revisions(project_id, procedure_id, revision) ON DELETE RESTRICT
);
CREATE INDEX build_agent_catalog_procedures_snapshot_idx
  ON build_agent_catalog_procedures(project_id, catalog_id);

CREATE TABLE build_agent_catalog_widgets (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  catalog_id text NOT NULL,
  widget_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  PRIMARY KEY (project_id, catalog_id, widget_id),
  CONSTRAINT build_agent_catalog_widgets_snapshot_fk
    FOREIGN KEY (project_id, catalog_id)
    REFERENCES build_agent_catalog_snapshots(project_id, id) ON DELETE CASCADE,
  CONSTRAINT build_agent_catalog_widgets_revision_fk
    FOREIGN KEY (project_id, widget_id, revision)
    REFERENCES build_widget_revisions(project_id, widget_id, revision) ON DELETE RESTRICT
);
CREATE INDEX build_agent_catalog_widgets_snapshot_idx
  ON build_agent_catalog_widgets(project_id, catalog_id);
