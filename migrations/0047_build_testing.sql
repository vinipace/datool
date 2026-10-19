-- Durable Build simulations and reviewable management-copilot proposals.
-- Test runs snapshot the agent before execution; no case can call a live write
-- action unless the runtime explicitly provides a non-production adapter.

CREATE TABLE IF NOT EXISTS build_test_definitions (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  definition_json jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('active','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  UNIQUE (project_id, id),
  UNIQUE (project_id, agent_id, name)
);
CREATE INDEX IF NOT EXISTS build_test_definitions_project_agent_idx
  ON build_test_definitions(project_id, agent_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS build_test_definition_revisions (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  definition_id text NOT NULL,
  agent_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  definition_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  UNIQUE (project_id, id),
  UNIQUE (project_id, definition_id, revision),
  FOREIGN KEY (project_id, definition_id)
    REFERENCES build_test_definitions(project_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS build_test_definition_revisions_project_definition_idx
  ON build_test_definition_revisions(project_id, definition_id, revision DESC);

CREATE TABLE IF NOT EXISTS build_test_tool_mocks (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  definition_id text NOT NULL,
  mock_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, definition_id)
    REFERENCES build_test_definitions(project_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS build_test_tool_mocks_project_definition_idx
  ON build_test_tool_mocks(project_id, definition_id, created_at DESC);

CREATE TABLE IF NOT EXISTS build_test_runs (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  definition_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','completed','cancelled','failed')),
  requested_cases integer NOT NULL CHECK (requested_cases > 0),
  completed_cases integer NOT NULL DEFAULT 0 CHECK (completed_cases >= 0),
  passed_cases integer NOT NULL DEFAULT 0 CHECK (passed_cases >= 0),
  failed_cases integer NOT NULL DEFAULT 0 CHECK (failed_cases >= 0),
  no_verdict_cases integer NOT NULL DEFAULT 0 CHECK (no_verdict_cases >= 0),
  infra_error_cases integer NOT NULL DEFAULT 0 CHECK (infra_error_cases >= 0),
  config_snapshot_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error text,
  requested_by text,
  lease_owner text,
  lease_expires_at timestamptz,
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, definition_id)
    REFERENCES build_test_definitions(project_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS build_test_runs_project_definition_idx
  ON build_test_runs(project_id, definition_id, created_at DESC);
CREATE INDEX IF NOT EXISTS build_test_runs_claim_idx
  ON build_test_runs(project_id, status, lease_expires_at);

CREATE TABLE IF NOT EXISTS build_test_cases (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  run_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  repeat_index integer NOT NULL CHECK (repeat_index >= 0),
  variant_key text NOT NULL,
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','completed','cancelled','failed')),
  transcript_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  observed_actions_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  verdict_json jsonb,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  UNIQUE (project_id, id),
  UNIQUE (project_id, run_id, ordinal, variant_key),
  FOREIGN KEY (project_id, run_id)
    REFERENCES build_test_runs(project_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS build_test_cases_project_run_idx
  ON build_test_cases(project_id, run_id, ordinal);
CREATE INDEX IF NOT EXISTS build_test_cases_claim_idx
  ON build_test_cases(project_id, status, lease_expires_at);

CREATE TABLE IF NOT EXISTS build_copilot_proposals (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('instructions','procedure','widget','action')),
  target_id text,
  status text NOT NULL CHECK (status IN ('proposed','approved','rejected','applied','expired')),
  base_revision integer NOT NULL CHECK (base_revision > 0),
  request text NOT NULL CHECK (length(btrim(request)) BETWEEN 1 AND 16000),
  source_snapshot_json jsonb NOT NULL,
  proposed_value_json jsonb NOT NULL,
  diff_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  approved_at timestamptz,
  approved_by text,
  applied_at timestamptz,
  UNIQUE (project_id, id)
);
CREATE INDEX IF NOT EXISTS build_copilot_proposals_project_agent_idx
  ON build_copilot_proposals(project_id, agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS build_copilot_proposals_status_idx
  ON build_copilot_proposals(project_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS build_copilot_audit (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  proposal_id text NOT NULL,
  event text NOT NULL,
  actor_id text,
  payload_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, proposal_id)
    REFERENCES build_copilot_proposals(project_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS build_copilot_audit_project_proposal_idx
  ON build_copilot_audit(project_id, proposal_id, created_at DESC);

-- Add tenant-safe agent references only when the Build catalog is installed.
DO $$
BEGIN
  IF to_regclass('build_agents') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'build_test_definitions_project_agent_fk'
        AND conrelid = 'build_test_definitions'::regclass
    ) THEN
      ALTER TABLE build_test_definitions
        ADD CONSTRAINT build_test_definitions_project_agent_fk
        FOREIGN KEY (project_id, agent_id)
        REFERENCES build_agents(project_id, id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'build_copilot_proposals_project_agent_fk'
        AND conrelid = 'build_copilot_proposals'::regclass
    ) THEN
      ALTER TABLE build_copilot_proposals
        ADD CONSTRAINT build_copilot_proposals_project_agent_fk
        FOREIGN KEY (project_id, agent_id)
        REFERENCES build_agents(project_id, id) ON DELETE CASCADE;
    END IF;
  END IF;
END $$;
