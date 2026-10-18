-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Enrollment-only positive provider observations. Legacy sessions remain at
-- version zero and create no expiry work. Existing forced system-only RLS and
-- grants cover these columns; no provider credential is persisted here.
ALTER TABLE auth_sessions
  ADD COLUMN provider_session_proof_version bigint NOT NULL DEFAULT 0
    CHECK (provider_session_proof_version BETWEEN 0 AND 9007199254740991),
  ADD COLUMN provider_session_proved_at timestamptz
    CHECK (provider_session_proved_at IS NULL OR isfinite(provider_session_proved_at)),
  ADD CONSTRAINT auth_session_provider_proof_finite CHECK (
    provider_session_proof_version = 0 OR
    COALESCE(isfinite(provider_session_expires_at), false)
  );

CREATE INDEX auth_sessions_proved_expiry_idx
  ON auth_sessions (provider_session_expires_at, id)
  WHERE status = 'active' AND provider_session_proof_version > 0;
