-- ─────────────────────────────────────────────────────────────────────────────
-- 0056 — Keyed secret verifiers and versioned keyring compatibility
-- ─────────────────────────────────────────────────────────────────────────────
-- A raw SHA-256 of a low-entropy secret lets a database-only attacker test
-- guesses offline. Remove that oracle. New rows carry a domain-separated HMAC
-- verifier; legacy ciphertext remains readable through authenticated decryption
-- and receives a verifier naturally when an operator rotates the binding.

ALTER TABLE secret_binding_versions
  ADD COLUMN verifier_scheme smallint NOT NULL DEFAULT 0,
  ADD COLUMN value_verifier bytea,
  ADD CONSTRAINT secret_binding_versions_verifier_check CHECK (
    (verifier_scheme = 0 AND value_verifier IS NULL)
    OR (
      verifier_scheme = 1
      AND value_verifier IS NOT NULL
      AND octet_length(value_verifier) = 32
    )
  );

ALTER TABLE secret_binding_versions
  DROP COLUMN value_sha256;

-- Every post-migration writer must select its verifier scheme explicitly.
ALTER TABLE secret_binding_versions
  ALTER COLUMN verifier_scheme DROP DEFAULT;

COMMENT ON COLUMN secret_binding_versions.verifier_scheme IS
  '0 = migrated legacy AES-GCM row without verifier; 1 = contextual HMAC-SHA-256';
COMMENT ON COLUMN secret_binding_versions.value_verifier IS
  'Domain-separated keyed verifier; never a raw digest of the secret value';
