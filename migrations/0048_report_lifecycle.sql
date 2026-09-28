ALTER TABLE reports ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'published';
ALTER TABLE reports ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS updated_at text;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS published_at text;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS public_token text;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS input_json text;
UPDATE reports SET updated_at=created_at, published_at=created_at WHERE updated_at IS NULL;
ALTER TABLE reports ALTER COLUMN status SET DEFAULT 'draft';
CREATE UNIQUE INDEX IF NOT EXISTS reports_public_token_key ON reports(public_token) WHERE public_token IS NOT NULL;
ALTER TABLE reports ADD CONSTRAINT reports_lifecycle_check CHECK (
  status IN ('draft','published') AND revision > 0 AND
  (public_token IS NULL OR status='published')
);
