-- Existing deployments and durable resources remain in production.
ALTER TABLE project_deployments ADD COLUMN environment text NOT NULL DEFAULT 'production' CHECK (environment IN ('preview','production'));
ALTER TABLE project_deployments ADD UNIQUE(project_id,environment,id);
DROP INDEX project_deployments_history;
CREATE INDEX project_deployments_history ON project_deployments(project_id,environment,created_at DESC,id DESC);

ALTER TABLE project_deployment_state ADD COLUMN environment text NOT NULL DEFAULT 'production' CHECK (environment IN ('preview','production'));
ALTER TABLE project_deployment_state DROP CONSTRAINT project_deployment_state_pkey;
ALTER TABLE project_deployment_state ADD PRIMARY KEY(project_id,environment);
ALTER TABLE project_deployment_state ADD FOREIGN KEY(project_id,environment,active_id) REFERENCES project_deployments(project_id,environment,id);

ALTER TABLE project_deployed_agents ADD COLUMN environment text NOT NULL DEFAULT 'production' CHECK (environment IN ('preview','production'));
ALTER TABLE project_deployed_agents DROP CONSTRAINT project_deployed_agents_pkey;
ALTER TABLE project_deployed_agents ADD PRIMARY KEY(project_id,environment,slug);

ALTER TABLE project_documents ADD COLUMN environment text NOT NULL DEFAULT 'production' CHECK (environment IN ('preview','production'));
ALTER TABLE project_documents DROP CONSTRAINT project_documents_pkey;
ALTER TABLE project_documents ADD PRIMARY KEY(project_id,environment,collection,key);

ALTER TABLE project_bucket_objects ADD COLUMN environment text NOT NULL DEFAULT 'production' CHECK (environment IN ('preview','production'));
ALTER TABLE project_bucket_objects DROP CONSTRAINT project_bucket_objects_pkey;
ALTER TABLE project_bucket_objects ADD PRIMARY KEY(project_id,environment,key);

ALTER TABLE project_postgres ADD COLUMN environment text NOT NULL DEFAULT 'production' CHECK (environment IN ('preview','production'));
ALTER TABLE project_postgres DROP CONSTRAINT project_postgres_pkey;
ALTER TABLE project_postgres ADD PRIMARY KEY(project_id,environment);
