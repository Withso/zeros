-- Indexed transcript reads are independent of worker runtime availability.
-- The durable document keeps ord as a JSON number; JSONB ordering avoids a
-- migration-time cast of historical or unsupported document versions.
CREATE INDEX workspace_record_message_history
  ON workspace_record_entities (workspace_id, org_id, (document->>'chatId'), (document->'ord') DESC, entity_id)
  WHERE entity_kind='message' AND tombstoned_at IS NULL;
