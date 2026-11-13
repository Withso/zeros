-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- zeros-expand-exception: optional-source-fingerprint Membership authority carries no GitHub verification fingerprint
ALTER TABLE cloud_v2_execution_contexts ALTER COLUMN source_fingerprint DROP NOT NULL;

-- zeros-expand-exception: execution-signature-compatibility Capture v1 and v2 hash inputs for membership-only signature readers
CREATE OR REPLACE FUNCTION capture_cloud_execution_legacy_basis() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE workspace uuid; person uuid; authority jsonb; basis jsonb;
BEGIN
  IF TG_TABLE_NAME='cloud_v2_execution_contexts' THEN
    workspace := NEW.workspace_id; person := NEW.user_id; authority := NEW.authority;
  ELSIF TG_TABLE_NAME='cloud_v2_workspaces' THEN
    workspace := NEW.id; person := NEW.execution_initiator_user_id; authority := NEW.execution_intent_authority;
  ELSIF TG_TABLE_NAME='cloud_v2_prompt_outbox' THEN
    workspace := NEW.workspace_id; person := NEW.creator_user_id; authority := NEW.execution_authority;
  ELSE
    workspace := NEW.workspace_id; person := NEW.user_id; authority := NEW.execution_authority;
  END IF;
  IF authority IS NULL OR authority ? 'legacyBasis' OR coalesce(authority->>'signatureVersion','1') NOT IN ('1','2') THEN RETURN NEW; END IF;
  SELECT jsonb_build_object('permission',jsonb_build_array(w.id,w.org_id,person,w.creator_user_id,
      u.auth_revision::text,m.authorization_revision::text,m.created_at::text,o.authorization_revision::text,m.role,w.repository,
      coalesce((SELECT jsonb_agg(jsonb_build_object('repository',s.source_repository,'repositoryId',s.repository_id::text)
        ORDER BY s.source_repository) FROM public.cloud_v2_github_sources s WHERE s.workspace_id=w.id),'[]'::jsonb),
      jsonb_build_array((SELECT jsonb_build_array(g.selected_method,g.generation) FROM public.cloud_github_selections g
        WHERE g.org_id=w.org_id AND g.owner_user_id=person),
        (SELECT jsonb_agg(jsonb_build_array(g.id,g.method,g.generation,g.github_user_id) ORDER BY g.method)
          FROM public.cloud_github_credentials g WHERE g.org_id=w.org_id AND g.owner_user_id=person))),
      'policy',jsonb_build_array(o.is_personal,o.cloud_workspaces_allowed,o.deleted_at IS NULL),
      'accessEpoch',w.access_epoch::text,'stopGeneration',w.stop_generation::text,
      'bootId',CASE WHEN TG_TABLE_NAME='cloud_v2_execution_contexts' THEN w.worker_boot_id END,
      'workerTokenHash',CASE WHEN TG_TABLE_NAME='cloud_v2_execution_contexts' THEN encode(w.worker_token_hash,'hex') END) INTO basis
    FROM public.cloud_v2_workspaces w JOIN public.organizations o ON o.id=w.org_id
    JOIN public.organization_members m ON m.org_id=w.org_id AND m.user_id=person
    JOIN public.users u ON u.id=m.user_id WHERE w.id=workspace;
  IF basis IS NULL OR octet_length(basis::text)>65536 THEN RETURN NEW; END IF;
  authority := authority || jsonb_build_object('legacyBasis',basis);
  IF TG_TABLE_NAME='cloud_v2_execution_contexts' THEN NEW.authority := authority;
  ELSIF TG_TABLE_NAME='cloud_v2_workspaces' THEN NEW.execution_intent_authority := authority;
  ELSE NEW.execution_authority := authority;
  END IF;
  RETURN NEW;
END;
$$;

-- Bound the live compatibility backfill while DDL fences old writers. Retired
-- rows keep their historical format; new v3 writes do no compatibility lookup.
DO $$
BEGIN
  IF (SELECT count(*) FROM (
    SELECT 1 FROM cloud_v2_execution_contexts WHERE state='active' AND expires_at>clock_timestamp()
      AND coalesce(authority->>'signatureVersion','1') IN ('1','2') AND NOT authority ? 'legacyBasis'
    UNION ALL SELECT 1 FROM cloud_v2_tokens WHERE kind='connect' AND expires_at>clock_timestamp()
      AND execution_authority IS NOT NULL AND coalesce(execution_authority->>'signatureVersion','1') IN ('1','2') AND NOT execution_authority ? 'legacyBasis'
    UNION ALL SELECT 1 FROM cloud_v2_prompt_outbox WHERE state IN ('queued','inboxed','dispatching','accepted')
      AND execution_authority IS NOT NULL AND coalesce(execution_authority->>'signatureVersion','1') IN ('1','2') AND NOT execution_authority ? 'legacyBasis'
    UNION ALL SELECT 1 FROM cloud_v2_workspaces WHERE execution_mode='active' AND execution_intent_authority IS NOT NULL
      AND coalesce(execution_intent_authority->>'signatureVersion','1') IN ('1','2') AND NOT execution_intent_authority ? 'legacyBasis'
    LIMIT 10001
  ) live) > 10000 THEN RAISE EXCEPTION 'cloud_execution_legacy_backfill_limit'; END IF;
END;
$$;
UPDATE cloud_v2_execution_contexts SET authority=authority WHERE state='active' AND expires_at>clock_timestamp()
  AND coalesce(authority->>'signatureVersion','1') IN ('1','2') AND NOT authority ? 'legacyBasis';
UPDATE cloud_v2_tokens SET execution_authority=execution_authority WHERE execution_authority IS NOT NULL
  AND kind='connect' AND expires_at>clock_timestamp()
  AND coalesce(execution_authority->>'signatureVersion','1') IN ('1','2') AND NOT execution_authority ? 'legacyBasis';
UPDATE cloud_v2_prompt_outbox SET execution_authority=execution_authority WHERE execution_authority IS NOT NULL
  AND state IN ('queued','inboxed','dispatching','accepted')
  AND coalesce(execution_authority->>'signatureVersion','1') IN ('1','2') AND NOT execution_authority ? 'legacyBasis';
UPDATE cloud_v2_workspaces SET execution_intent_authority=execution_intent_authority
  WHERE execution_mode='active' AND execution_intent_authority IS NOT NULL
    AND coalesce(execution_intent_authority->>'signatureVersion','1') IN ('1','2') AND NOT execution_intent_authority ? 'legacyBasis';

-- zeros-expand-exception: membership-source-cutoff A repository denial refuses its GitHub operation without retiring workspace contexts
DROP TRIGGER execution_source_fence ON cloud_github_source_verifications;

-- zeros-expand-exception: membership-source-cutoff Changing a GitHub selection does not revoke organization membership
DROP TRIGGER execution_github_selection_fence ON cloud_github_selections;

-- zeros-expand-exception: membership-source-cutoff Disconnecting GitHub does not revoke organization membership
DROP TRIGGER execution_github_credential_fence ON cloud_github_credentials;
