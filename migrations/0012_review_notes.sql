ALTER TABLE review_items
  ADD COLUMN notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 16000);
