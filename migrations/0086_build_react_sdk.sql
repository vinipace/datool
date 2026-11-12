-- Server-authenticated app identities bind conversations, drives and proactive tasks.
CREATE UNIQUE INDEX IF NOT EXISTS build_drives_project_id_unique ON build_drives(project_id, id);
CREATE TABLE IF NOT EXISTS build_sdk_sessions (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  conversation_id text NOT NULL,
  connection_id uuid NOT NULL,
  scope_key text NOT NULL,
  drive_id uuid,
  FOREIGN KEY (project_id, connection_id) REFERENCES build_channel_connection(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, drive_id) REFERENCES build_drives(project_id, id),
  PRIMARY KEY (project_id, conversation_id),
  FOREIGN KEY (project_id, conversation_id) REFERENCES build_conversations(project_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS build_sdk_sessions_scope_idx ON build_sdk_sessions(project_id, connection_id, scope_key);
CREATE TABLE IF NOT EXISTS build_sdk_tasks (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  FOREIGN KEY (project_id, task_id) REFERENCES build_agent_schedules(project_id, id) ON DELETE CASCADE,
  conversation_id text NOT NULL,
  PRIMARY KEY (project_id, task_id),
  FOREIGN KEY (project_id, conversation_id) REFERENCES build_sdk_sessions(project_id, conversation_id) ON DELETE CASCADE
);

-- Removing a connection or conversation must not leave tasks running without
-- their authenticated scope. Cancel them while preserving their run history.
CREATE OR REPLACE FUNCTION datool_remove_sdk_session_tasks() RETURNS trigger AS $$
BEGIN
  UPDATE build_agent_schedules SET deleted_at=now(), status='paused', next_run_at=NULL, revision=revision+1, updated_at=now()
  WHERE project_id=OLD.project_id AND id IN (
    SELECT task_id FROM build_sdk_tasks WHERE project_id=OLD.project_id AND conversation_id=OLD.conversation_id
  );
  UPDATE build_agent_schedule_runs SET status='cancelled', finished_at=now(), error='SDK session removed.'
  WHERE project_id=OLD.project_id AND status IN ('queued','running') AND task_id IN (
    SELECT task_id FROM build_sdk_tasks WHERE project_id=OLD.project_id AND conversation_id=OLD.conversation_id
  );
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER build_sdk_session_remove_tasks BEFORE DELETE ON build_sdk_sessions
FOR EACH ROW EXECUTE FUNCTION datool_remove_sdk_session_tasks();
