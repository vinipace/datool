ALTER TABLE reports ADD COLUMN layout text NOT NULL DEFAULT 'canvas';
UPDATE reports SET layout = 'document' WHERE presentation_json IS NOT NULL;
