-- Project-wide references to existing dashboard widgets. Source definitions
-- remain in dashboards; home stores only placement and fallback labels.
CREATE TABLE project_home (
  project_id text PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  pins_json text NOT NULL DEFAULT '[]',
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
