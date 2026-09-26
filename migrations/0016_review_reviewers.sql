CREATE TABLE review_session_reviewers (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (project_id, session_id, user_id),
  UNIQUE (project_id, session_id, ordinal),
  FOREIGN KEY (project_id, session_id) REFERENCES review_sessions(project_id, id) ON DELETE CASCADE
);
CREATE INDEX review_session_reviewers_user_idx ON review_session_reviewers(user_id);

INSERT INTO review_session_reviewers(project_id, session_id, user_id, ordinal)
SELECT project_id, id, assignee_user_id, 0 FROM review_sessions WHERE assignee_user_id IS NOT NULL;
