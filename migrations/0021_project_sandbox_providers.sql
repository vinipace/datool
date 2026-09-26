CREATE TABLE project_sandbox_settings (
  project_id text PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  providers jsonb NOT NULL DEFAULT '{"local": null}'::jsonb,
  default_provider text DEFAULT 'local',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(providers) = 'object'),
  CHECK (providers - ARRAY['local', 'vercel', 'modal']::text[] = '{}'::jsonb),
  CHECK (
    (default_provider IS NULL AND providers = '{}'::jsonb)
    OR (default_provider IS NOT NULL AND providers ? default_provider)
  )
);
