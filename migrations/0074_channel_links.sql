CREATE TABLE build_channel_link (
 token text PRIMARY KEY CHECK(token ~ '^[A-Za-z0-9_-]{24}$'),
 project_id text NOT NULL,
 message_id text NOT NULL,
 destination text NOT NULL CHECK(length(destination) <= 2048),
 destination_hash text NOT NULL,
 label text NOT NULL DEFAULT '',
 estimated_clicks bigint NOT NULL DEFAULT 0,
 automated_visits bigint NOT NULL DEFAULT 0,
 last_clicked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now() + interval '90 days',
 UNIQUE(project_id,message_id,destination_hash),
 FOREIGN KEY(project_id,message_id) REFERENCES build_channel_message(project_id,id) ON DELETE CASCADE
);
CREATE INDEX build_channel_link_message_idx ON build_channel_link(project_id,message_id);
