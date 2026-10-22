ALTER TABLE llm_settings DROP CONSTRAINT llm_settings_id_check;
ALTER TABLE llm_settings ADD CONSTRAINT llm_settings_id_check
  CHECK (id IN ('primary', 'provider:openai', 'provider:gemini', 'provider:openrouter', 'provider:runware'));

INSERT INTO llm_settings (id, base_url, model, api_key_encrypted, revision, updated_at)
SELECT 'provider:' || CASE rtrim(base_url, '/')
  WHEN 'https://api.openai.com/v1' THEN 'openai'
  WHEN 'https://generativelanguage.googleapis.com/v1beta/openai' THEN 'gemini'
  WHEN 'https://openrouter.ai/api/v1' THEN 'openrouter'
  WHEN 'https://api.runware.ai/v1' THEN 'runware'
END, base_url, model, api_key_encrypted, revision, updated_at
FROM llm_settings WHERE id = 'primary' AND rtrim(base_url, '/') IN (
  'https://api.openai.com/v1', 'https://generativelanguage.googleapis.com/v1beta/openai',
  'https://openrouter.ai/api/v1', 'https://api.runware.ai/v1'
)
ON CONFLICT (id) DO NOTHING;
