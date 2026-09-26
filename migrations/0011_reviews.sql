CREATE TABLE review_sessions (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  prompt text NOT NULL DEFAULT '',
  assignee_user_id text REFERENCES "user"(id) ON DELETE SET NULL,
  created_by text REFERENCES "user"(id) ON DELETE SET NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at text NOT NULL,
  updated_at text NOT NULL,
  UNIQUE (project_id, id)
);
CREATE INDEX review_sessions_project_page_idx ON review_sessions(project_id, created_at, id);
CREATE INDEX review_sessions_assignee_idx ON review_sessions(project_id, assignee_user_id);

CREATE TABLE review_items (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  trace_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  reviewed_at text,
  reviewed_by text REFERENCES "user"(id) ON DELETE SET NULL,
  UNIQUE (project_id, id),
  UNIQUE (project_id, id, trace_id),
  UNIQUE (project_id, session_id, trace_id),
  UNIQUE (project_id, session_id, ordinal),
  FOREIGN KEY (project_id, session_id) REFERENCES review_sessions(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, trace_id) REFERENCES traces(project_id, id) ON DELETE NO ACTION
);
CREATE INDEX review_items_trace_idx ON review_items(project_id, trace_id);

CREATE TABLE review_scores (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  item_id text NOT NULL,
  trace_id text NOT NULL,
  criterion_key text NOT NULL,
  scorer_id text,
  scorer_revision integer,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  value double precision NOT NULL CHECK (value >= 0 AND value <= 1),
  comment text NOT NULL DEFAULT '',
  reviewer_id text REFERENCES "user"(id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('human', 'mcp')),
  updated_at text NOT NULL,
  UNIQUE (project_id, item_id, criterion_key),
  FOREIGN KEY (project_id, item_id, trace_id) REFERENCES review_items(project_id, id, trace_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, scorer_id) REFERENCES evaluators(project_id, id) ON DELETE NO ACTION
);
CREATE INDEX review_scores_trace_page_idx ON review_scores(project_id, trace_id, updated_at, id);
