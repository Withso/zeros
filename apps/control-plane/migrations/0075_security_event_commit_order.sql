-- zeros:requires-controlled-downtime
-- An identity sequence orders allocation, not commit. Retain the original
-- record identity and every previously issued cursor, then publish NEW rows
-- through a separate, short transaction after their entity mutations commit.
-- Drain old API/SSE readers before upgrading: legacy readers emit allocation
-- order and must never run alongside readers using publication order.
ALTER TABLE security_events ADD COLUMN delivery_sequence bigint;
UPDATE security_events SET delivery_sequence = sequence;
CREATE SEQUENCE security_event_delivery_sequence AS bigint;
SELECT setval('security_event_delivery_sequence',
  greatest(coalesce((SELECT max(delivery_sequence) FROM security_events), 0),
    (SELECT last_value FROM security_events_sequence_seq), 1),
  (SELECT is_called FROM security_events_sequence_seq) OR EXISTS (SELECT 1 FROM security_events));
GRANT USAGE, SELECT ON SEQUENCE security_event_delivery_sequence TO zeros_app;
CREATE UNIQUE INDEX security_events_delivery_cursor_idx
  ON security_events (delivery_sequence);
CREATE INDEX security_events_pending_delivery_idx
  ON security_events (expires_at, sequence) WHERE delivery_sequence IS NULL;
DROP INDEX security_events_user_cursor_idx;
DROP INDEX security_events_org_cursor_idx;
DROP INDEX security_events_session_cursor_idx;
CREATE INDEX security_events_user_cursor_idx
  ON security_events (user_id, delivery_sequence) WHERE user_id IS NOT NULL;
CREATE INDEX security_events_org_cursor_idx
  ON security_events (org_id, delivery_sequence) WHERE org_id IS NOT NULL;
CREATE INDEX security_events_session_cursor_idx
  ON security_events (provider_session_id, delivery_sequence)
  WHERE provider_session_id IS NOT NULL;
