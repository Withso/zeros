-- ──────────────────────────────────────────────────────────
-- 0061 — durable WorkOS provider-erasure fences
-- ──────────────────────────────────────────────────────────
-- zeros:requires-controlled-downtime
-- Provider identifiers are deleted during final customer-data erasure, but a
-- replayed token or late WorkOS event must never recreate the erased subject.
-- Keep only a domain-separated SHA-256 digest and explicit per-request
-- reconciliation evidence. Historical purges without that evidence leave
-- unknown-subject authentication and event ingestion fail-closed until an
-- operator reconciles them from provider-side audit records.

CREATE TABLE workos_provider_erasure_fences (
  provider              text NOT NULL CHECK (provider = 'workos'),
  subject_kind          text NOT NULL CHECK (
    subject_kind IN ('user', 'organization')
  ),
  hash_version          smallint NOT NULL CHECK (hash_version = 1),
  subject_hash          text NOT NULL CHECK (
    subject_hash ~ '^[0-9a-f]{64}$'
  ),
  deletion_request_id   uuid NOT NULL
                        REFERENCES deletion_requests(id) ON DELETE RESTRICT,
  evidence_source       text NOT NULL DEFAULT 'lifecycle_event' CHECK (
    evidence_source IN ('lifecycle_event', 'operator_reconciliation')
  ),
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject_kind, hash_version, subject_hash)
);
CREATE INDEX workos_provider_erasure_fences_request_idx
  ON workos_provider_erasure_fences (deletion_request_id);

CREATE TABLE workos_provider_erasure_reconciliations (
  deletion_request_id   uuid PRIMARY KEY
                        REFERENCES deletion_requests(id) ON DELETE RESTRICT,
  disposition           text NOT NULL CHECK (
    disposition IN ('fenced', 'no_workos_subject')
  ),
  evidence_source       text NOT NULL CHECK (
    evidence_source IN ('lifecycle_event', 'lifecycle_worker',
                        'operator_reconciliation')
  ),
  evidence_reference    text NOT NULL CHECK (
    char_length(evidence_reference) BETWEEN 6 AND 512
  ),
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- This partial index keeps the dynamic readiness sentinel bounded. Readiness
-- becomes false automatically if an old binary commits another purge without
-- evidence after this migration; the drained rollout remains mandatory to
-- close the concurrent mapping-deletion race itself.
CREATE INDEX deletion_requests_purged_erasure_reconciliation_idx
  ON deletion_requests (id)
  WHERE state = 'purged';

CREATE FUNCTION reject_workos_provider_erasure_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER workos_provider_erasure_fences_append_only
  BEFORE UPDATE OR DELETE ON workos_provider_erasure_fences
  FOR EACH ROW EXECUTE FUNCTION reject_workos_provider_erasure_evidence_mutation();
CREATE TRIGGER workos_provider_erasure_fences_no_truncate
  BEFORE TRUNCATE ON workos_provider_erasure_fences
  FOR EACH STATEMENT EXECUTE FUNCTION reject_workos_provider_erasure_evidence_mutation();
CREATE TRIGGER workos_provider_erasure_reconciliations_append_only
  BEFORE UPDATE OR DELETE ON workos_provider_erasure_reconciliations
  FOR EACH ROW EXECUTE FUNCTION reject_workos_provider_erasure_evidence_mutation();
CREATE TRIGGER workos_provider_erasure_reconciliations_no_truncate
  BEFORE TRUNCATE ON workos_provider_erasure_reconciliations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_workos_provider_erasure_evidence_mutation();

CREATE FUNCTION validate_workos_provider_erasure_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'workos-provider-erasure-request:' || NEW.deletion_request_id::text,
    0
  ));
  IF EXISTS (
    SELECT 1 FROM workos_provider_erasure_reconciliations reconciliation
    WHERE reconciliation.deletion_request_id = NEW.deletion_request_id
      AND reconciliation.disposition = 'no_workos_subject'
  ) THEN
    RAISE EXCEPTION 'a no-subject WorkOS reconciliation is already final'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.subject_kind = 'user'
     AND NOT EXISTS (
       SELECT 1 FROM workos_provider_erasure_fences fence
       WHERE fence.provider = NEW.provider
         AND fence.subject_kind = NEW.subject_kind
         AND fence.hash_version = NEW.hash_version
         AND fence.subject_hash = NEW.subject_hash
     )
     AND (
       SELECT count(*)
       FROM workos_provider_erasure_fences fence
       WHERE fence.deletion_request_id = NEW.deletion_request_id
         AND fence.provider = 'workos'
         AND fence.subject_kind = 'user'
         AND fence.hash_version = 1
     ) >= 256 THEN
    RAISE EXCEPTION 'workos_user_erasure_subject_limit_exceeded'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workos_provider_erasure_fences_validate
  BEFORE INSERT ON workos_provider_erasure_fences
  FOR EACH ROW EXECUTE FUNCTION validate_workos_provider_erasure_fence();

-- Preserve the existing append-only lifecycle event as human-auditable
-- evidence while projecting it into an exact-key runtime lookup. The trigger
-- also keeps direct maintenance/event replay compatible with the runtime
-- fence table without persisting the raw WorkOS identifier.
CREATE FUNCTION project_workos_provider_erasure_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_kind text;
  candidate text;
BEGIN
  IF NEW.action <> 'purge.provider_erasure_fenced' THEN
    RETURN NEW;
  END IF;
  IF NEW.metadata->>'provider' <> 'workos'
     OR jsonb_typeof(NEW.metadata->'workosSubjectHashes') <> 'array'
     OR jsonb_array_length(NEW.metadata->'workosSubjectHashes') = 0 THEN
    RAISE EXCEPTION 'invalid WorkOS provider-erasure fence evidence'
      USING ERRCODE = '23514';
  END IF;

  SELECT CASE request.target_kind
           WHEN 'account' THEN 'user'
           ELSE 'organization'
         END
  INTO target_kind
  FROM deletion_requests request
  WHERE request.id = NEW.deletion_request_id;
  IF target_kind IS NULL THEN
    RAISE EXCEPTION 'provider-erasure fence target is missing'
      USING ERRCODE = '23503';
  END IF;

  FOR candidate IN
    SELECT value
    FROM jsonb_array_elements_text(
      NEW.metadata->'workosSubjectHashes'
    ) AS hashes(value)
  LOOP
    IF candidate !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'invalid WorkOS provider-erasure subject hash'
      USING ERRCODE = '23514';
    END IF;
    INSERT INTO workos_provider_erasure_fences (
      provider, subject_kind, hash_version, subject_hash,
      deletion_request_id, evidence_source
    ) VALUES (
      'workos', target_kind, 1, candidate,
      NEW.deletion_request_id, 'lifecycle_event'
    )
    ON CONFLICT (provider, subject_kind, hash_version, subject_hash)
    DO NOTHING;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER deletion_request_events_project_workos_erasure_fence
  AFTER INSERT ON deletion_request_events
  FOR EACH ROW EXECUTE FUNCTION project_workos_provider_erasure_fence();

CREATE FUNCTION validate_workos_provider_erasure_reconciliation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  fence_exists boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'workos-provider-erasure-request:' || NEW.deletion_request_id::text,
    0
  ));
  SELECT EXISTS (
    SELECT 1 FROM workos_provider_erasure_fences fence
    WHERE fence.deletion_request_id = NEW.deletion_request_id
      AND fence.provider = 'workos'
  ) INTO fence_exists;
  IF (NEW.disposition = 'fenced' AND NOT fence_exists)
     OR (NEW.disposition = 'no_workos_subject' AND fence_exists) THEN
    RAISE EXCEPTION 'WorkOS provider-erasure reconciliation contradicts fences'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workos_provider_erasure_reconciliations_validate
  BEFORE INSERT ON workos_provider_erasure_reconciliations
  FOR EACH ROW EXECUTE FUNCTION validate_workos_provider_erasure_reconciliation();

-- Backfill valid evidence written by an earlier build of the new purge path.
-- Malformed or absent evidence deliberately remains unresolved.
WITH candidate_fences AS (
  SELECT event.deletion_request_id,
         CASE request.target_kind
           WHEN 'account' THEN 'user'
           ELSE 'organization'
         END AS subject_kind,
         hash.value AS subject_hash
  FROM deletion_request_events event
  JOIN deletion_requests request ON request.id = event.deletion_request_id
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE
      WHEN jsonb_typeof(event.metadata->'workosSubjectHashes') = 'array'
        THEN event.metadata->'workosSubjectHashes'
      ELSE '[]'::jsonb
    END
  ) AS hash(value)
  WHERE event.action = 'purge.provider_erasure_fenced'
    AND event.metadata->>'provider' = 'workos'
    AND hash.value ~ '^[0-9a-f]{64}$'
)
INSERT INTO workos_provider_erasure_fences (
  provider, subject_kind, hash_version, subject_hash,
  deletion_request_id, evidence_source
)
SELECT 'workos', subject_kind, 1, subject_hash,
       deletion_request_id, 'lifecycle_event'
FROM candidate_fences
ON CONFLICT (provider, subject_kind, hash_version, subject_hash) DO NOTHING;

INSERT INTO workos_provider_erasure_reconciliations (
  deletion_request_id, disposition, evidence_source, evidence_reference
)
SELECT DISTINCT fence.deletion_request_id, 'fenced', 'lifecycle_event',
       'migration-0061:lifecycle-event-backfill'
FROM workos_provider_erasure_fences fence
ON CONFLICT (deletion_request_id) DO NOTHING;

ALTER TABLE workos_provider_erasure_fences ENABLE ROW LEVEL SECURITY;
ALTER TABLE workos_provider_erasure_reconciliations ENABLE ROW LEVEL SECURITY;
CREATE POLICY workos_provider_erasure_fences_system
  ON workos_provider_erasure_fences FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY workos_provider_erasure_reconciliations_system
  ON workos_provider_erasure_reconciliations FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE workos_provider_erasure_fences FORCE ROW LEVEL SECURITY;
ALTER TABLE workos_provider_erasure_reconciliations FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON
  workos_provider_erasure_fences,
  workos_provider_erasure_reconciliations
TO zeros_app;
REVOKE UPDATE, DELETE, TRUNCATE ON
  workos_provider_erasure_fences,
  workos_provider_erasure_reconciliations
FROM zeros_app;
REVOKE ALL ON FUNCTION reject_workos_provider_erasure_evidence_mutation()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION validate_workos_provider_erasure_fence() FROM PUBLIC;
REVOKE ALL ON FUNCTION project_workos_provider_erasure_fence() FROM PUBLIC;
REVOKE ALL ON FUNCTION validate_workos_provider_erasure_reconciliation()
  FROM PUBLIC;
