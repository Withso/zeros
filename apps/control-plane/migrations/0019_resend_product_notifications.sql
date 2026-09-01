-- ──────────────────────────────────────────────────────────
-- 0019 — Resend product notifications
-- ──────────────────────────────────────────────────────────
-- Provider identity belongs to each durable delivery. This prevents a
-- provider migration or an operator requeue from silently sending an old
-- message through a different vendor with different idempotency semantics.

ALTER TABLE security_notification_outbox
  ADD COLUMN delivery_provider text,
  ADD COLUMN provider_message_id text CHECK (
    provider_message_id IS NULL
    OR char_length(provider_message_id) BETWEEN 1 AND 128
  );

-- Everything already present was created for the retired ZeptoMail sender.
-- Preserve every row as audit evidence, but terminally retire unfinished
-- deliveries so enabling Resend cannot release a backlog of stale lifecycle
-- test messages. A reviewed replay must create a new Resend-owned row.
UPDATE security_notification_outbox
SET delivery_provider = 'legacy_zeptomail';

UPDATE security_notification_outbox
SET state = 'dead',
    lease_owner = NULL,
    lease_expires_at = NULL,
    last_error_code = 'provider_retired_zeptomail'
WHERE state IN ('queued', 'sending');

ALTER TABLE security_notification_outbox
  ALTER COLUMN delivery_provider SET DEFAULT 'resend',
  ALTER COLUMN delivery_provider SET NOT NULL,
  ADD CONSTRAINT security_notification_delivery_provider_check CHECK (
    delivery_provider IN ('legacy_zeptomail', 'resend')
  );

CREATE FUNCTION reject_security_notification_delivery_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.delivery_provider IS DISTINCT FROM OLD.delivery_provider THEN
    RAISE EXCEPTION 'Security notification delivery provider is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.provider_message_id IS NOT NULL
     AND NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id THEN
    RAISE EXCEPTION 'Security notification provider message ID is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER security_notification_delivery_immutable
  BEFORE UPDATE OF delivery_provider, provider_message_id
  ON security_notification_outbox
  FOR EACH ROW EXECUTE FUNCTION reject_security_notification_delivery_rewrite();
REVOKE ALL ON FUNCTION reject_security_notification_delivery_rewrite() FROM PUBLIC;
