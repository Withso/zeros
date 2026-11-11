-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- creator_user_id on a prompt receipt already means its authenticated sender,
-- not the workspace's current Creator. Keep it through replay and compaction.
-- These references are provenance, not authority; N-1 inserts leave them null.
ALTER TABLE cloud_v2_prompt_outbox
  ADD COLUMN sender_provider_session_id text CHECK (char_length(sender_provider_session_id) BETWEEN 1 AND 512),
  ADD COLUMN sender_credential_kind text CHECK (sender_credential_kind IN ('api_key','workspace_token')),
  ADD COLUMN sender_credential_id uuid,
  ADD COLUMN sender_context_id uuid,
  ADD CONSTRAINT cloud_v2_prompt_sender_credential_pair CHECK (
    (sender_credential_kind IS NULL) = (sender_credential_id IS NULL));
