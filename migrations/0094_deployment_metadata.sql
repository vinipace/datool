ALTER TABLE project_deployments ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}';
ALTER TABLE project_deployments ADD COLUMN duration_ms integer CHECK (duration_ms >= 0);
