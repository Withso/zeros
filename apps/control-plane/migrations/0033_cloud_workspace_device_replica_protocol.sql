-- ──────────────────────────────────────────────────────────
-- 0033 — exact device identity and idempotent replica enrollment
--
-- A receive-only replica is a private user/device projection. Account bearer
-- authentication chooses the user; an Ed25519 proof demonstrates possession
-- of the registered device key for every replica mutation or data read.
-- ──────────────────────────────────────────────────────────

ALTER TABLE devices
  ADD COLUMN key_algorithm text NOT NULL DEFAULT 'ed25519' CHECK (
    key_algorithm = 'ed25519'
  ),
  ADD COLUMN registration_idempotency_key text CHECK (
    registration_idempotency_key IS NULL OR
    char_length(registration_idempotency_key) BETWEEN 8 AND 128
  ),
  ADD COLUMN registration_request_sha256 bytea CHECK (
    registration_request_sha256 IS NULL OR
    octet_length(registration_request_sha256) = 32
  ),
  ADD CONSTRAINT devices_registration_pair_check CHECK (
    (registration_idempotency_key IS NULL) =
    (registration_request_sha256 IS NULL)
  );
CREATE UNIQUE INDEX devices_registration_idempotency_unique
  ON devices(user_id, registration_idempotency_key)
  WHERE registration_idempotency_key IS NOT NULL;

ALTER TABLE workspace_replicas
  ADD COLUMN idempotency_key text CHECK (
    idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 8 AND 128
  ),
  ADD COLUMN request_sha256 bytea CHECK (
    request_sha256 IS NULL OR octet_length(request_sha256) = 32
  ),
  ADD CONSTRAINT workspace_replicas_request_pair_check CHECK (
    (idempotency_key IS NULL) = (request_sha256 IS NULL)
  );
CREATE UNIQUE INDEX workspace_replicas_idempotency_unique
  ON workspace_replicas(user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- This is a public key, not a generic certificate or PEM container. Existing
-- pre-release rows are retained for migration diagnostics but cannot be used
-- by the service unless they have the exact 32-byte Ed25519 encoding.
COMMENT ON COLUMN devices.public_key IS
  'Raw 32-byte Ed25519 public key; validated exactly by the replica service';
