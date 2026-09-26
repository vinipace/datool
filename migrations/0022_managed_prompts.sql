CREATE TABLE managed_prompts (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  slug text NOT NULL,
  config_json text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at text NOT NULL,
  updated_at text NOT NULL,
  UNIQUE (project_id, id),
  UNIQUE (project_id, slug)
);
CREATE TABLE managed_prompt_versions (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  prompt_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  config_json text NOT NULL,
  created_at text NOT NULL,
  UNIQUE (project_id, prompt_id, revision),
  FOREIGN KEY (project_id, prompt_id) REFERENCES managed_prompts(project_id, id) ON DELETE CASCADE
);
