-- Presentation revisions never replace captured configuration or evidence.
ALTER TABLE reports ADD COLUMN presentation_json text;
ALTER TABLE reports ADD COLUMN presentation_revision integer NOT NULL DEFAULT 0;
