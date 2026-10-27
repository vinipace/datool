-- A row records a deliberately edited profile; Google may still refresh others.
-- Photos are bounded thumbnails, served by opaque IDs without account details.
CREATE TABLE user_profile (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  photo_id uuid UNIQUE,
  photo bytea,
  CHECK ((photo_id IS NULL) = (photo IS NULL)),
  CHECK (octet_length(photo) <= 262144)
);
