ALTER TABLE project_model_provider
  DROP CONSTRAINT project_model_provider_provider_check,
  ADD CONSTRAINT project_model_provider_provider_check
    CHECK (provider IN ('vercel-ai-gateway', 'typesafe-ai'));
