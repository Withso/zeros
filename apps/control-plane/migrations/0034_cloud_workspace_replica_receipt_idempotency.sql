-- ──────────────────────────────────────────────────────────
-- 0034 — retry-safe local replica receipts
--
-- A desktop applies files before acknowledging the revision. If the receipt
-- response is lost, retrying must return the original result even when that
-- first receipt advanced the cursor or fenced a diverged replica grant.
-- ──────────────────────────────────────────────────────────

ALTER TABLE workspace_replica_receipts
  ADD COLUMN idempotency_key text CHECK (
    idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 8 AND 128
  ),
  ADD COLUMN request_sha256 bytea CHECK (
    request_sha256 IS NULL OR octet_length(request_sha256) = 32
  ),
  ADD COLUMN response_json jsonb CHECK (
    response_json IS NULL OR jsonb_typeof(response_json) = 'object'
  ),
  ADD CONSTRAINT workspace_replica_receipts_retry_pair_check CHECK (
    (idempotency_key IS NULL) = (request_sha256 IS NULL)
    AND (idempotency_key IS NULL) = (response_json IS NULL)
  );

CREATE UNIQUE INDEX workspace_replica_receipts_idempotency_unique
  ON workspace_replica_receipts(replica_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
