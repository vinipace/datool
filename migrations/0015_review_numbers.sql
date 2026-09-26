ALTER TABLE review_sessions ADD COLUMN number integer;

WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY created_at::timestamptz, id)::integer AS number
  FROM review_sessions
)
UPDATE review_sessions SET number = numbered.number FROM numbered WHERE review_sessions.id = numbered.id;

ALTER TABLE review_sessions
  ALTER COLUMN number SET NOT NULL,
  ALTER COLUMN name SET DEFAULT 'Untitled Review',
  ADD CONSTRAINT review_sessions_number_check CHECK (number > 0);
CREATE UNIQUE INDEX review_sessions_project_number_key ON review_sessions(project_id, number);

CREATE TABLE review_session_counters (
  project_id text PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  last_number integer NOT NULL CHECK (last_number > 0)
);
INSERT INTO review_session_counters(project_id, last_number)
SELECT project_id, max(number) FROM review_sessions GROUP BY project_id;

-- The counter row serializes concurrent inserts within a project. Its update
-- rolls back with a failed insert and survives deletion of individual reviews.
CREATE FUNCTION datool_assign_review_number() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.number IS NOT NULL THEN
    RAISE EXCEPTION 'Review numbers are assigned automatically' USING ERRCODE = '23514';
  END IF;
  INSERT INTO review_session_counters(project_id, last_number) VALUES (NEW.project_id, 1)
  ON CONFLICT (project_id) DO UPDATE SET last_number = review_session_counters.last_number + 1
  RETURNING last_number INTO NEW.number;
  RETURN NEW;
END;
$$;
CREATE TRIGGER review_sessions_assign_number BEFORE INSERT ON review_sessions
FOR EACH ROW EXECUTE FUNCTION datool_assign_review_number();
