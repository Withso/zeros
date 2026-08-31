-- ──────────────────────────────────────────────────────────
-- 0047 — exact replica-command idempotency responses
--
-- A pause response can be lost and retried after a later resume. Persist the
-- original non-secret replica snapshot so the retry does not masquerade the
-- current state as the result of the old command. Resume credentials remain
-- verifier-only and are replaced on an eligible retry instead of being stored.
-- ──────────────────────────────────────────────────────────

ALTER TABLE workspace_replica_commands
  ADD COLUMN response_json jsonb CHECK (
    response_json IS NULL OR jsonb_typeof(response_json) = 'object'
  );
