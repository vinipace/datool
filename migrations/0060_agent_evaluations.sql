-- Agent tests reuse the project dataset library and evaluation history.
ALTER TABLE datasets ADD COLUMN agent_id text;
ALTER TABLE eval_runs ADD COLUMN agent_id text;

ALTER TABLE datasets ADD CONSTRAINT datasets_project_agent_fk
  FOREIGN KEY (project_id, agent_id) REFERENCES build_agents(project_id, id);
ALTER TABLE eval_runs ADD CONSTRAINT eval_runs_project_agent_fk
  FOREIGN KEY (project_id, agent_id) REFERENCES build_agents(project_id, id);

CREATE INDEX datasets_agent_page_idx ON datasets(project_id, agent_id, updated_at, id);
CREATE INDEX eval_runs_agent_page_idx ON eval_runs(project_id, agent_id, created_at, id);
