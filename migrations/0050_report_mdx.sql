ALTER TABLE reports ADD COLUMN IF NOT EXISTS mdx_json text;

ALTER TABLE reports DROP CONSTRAINT reports_widget_count_check;
ALTER TABLE reports ADD CONSTRAINT reports_widget_count_check CHECK (widget_count BETWEEN 0 AND 100);
