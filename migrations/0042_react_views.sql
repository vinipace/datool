CREATE TABLE react_views (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL,
  code text NOT NULL,
  requirements jsonb,
  origin jsonb,
  author jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX react_views_project_page_idx ON react_views(project_id, id);
