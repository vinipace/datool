-- Authorship is recorded on creation. Historical creators cannot be inferred.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS author jsonb;
