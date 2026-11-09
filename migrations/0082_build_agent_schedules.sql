CREATE TABLE build_agent_schedules (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  name text NOT NULL,
  prompt text NOT NULL,
  channel text NOT NULL,
  schedule_json jsonb NOT NULL,
  timezone text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'paused', 'completed')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  next_run_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, agent_id) REFERENCES build_agents(project_id, id) ON DELETE CASCADE
);
CREATE INDEX build_agent_schedules_agent ON build_agent_schedules(project_id, agent_id, id) WHERE deleted_at IS NULL;
CREATE INDEX build_agent_schedules_due ON build_agent_schedules(next_run_at) WHERE status = 'active' AND deleted_at IS NULL;

CREATE TABLE build_agent_schedule_runs (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('schedule', 'manual')),
  request_key text NOT NULL,
  snapshot_json jsonb NOT NULL,
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'blocked', 'needs_attention', 'failed', 'cancelled')),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  conversation_id text REFERENCES build_conversations(id) ON DELETE SET NULL,
  trace_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, task_id) REFERENCES build_agent_schedules(project_id, id) ON DELETE CASCADE,
  UNIQUE (task_id, request_key)
);
CREATE INDEX build_agent_schedule_runs_history ON build_agent_schedule_runs(project_id, task_id, created_at DESC, id DESC);
CREATE INDEX build_agent_schedule_runs_pending ON build_agent_schedule_runs(available_at, lease_expires_at) WHERE status IN ('queued', 'running');
-- One occurrence per task at a time, including manual runs and crash recovery.
CREATE UNIQUE INDEX build_agent_schedule_runs_active ON build_agent_schedule_runs(task_id) WHERE status IN ('queued', 'running');
