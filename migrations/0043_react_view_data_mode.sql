ALTER TABLE react_views ADD COLUMN data_mode text NOT NULL DEFAULT 'full' CHECK (data_mode IN ('full', 'summary'));
