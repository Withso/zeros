-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';
-- R2 message authority (message-authority-v1). A per-workspace authority sequence that every
-- revocation advances in the revoking transaction; the control plane signs worker freshness only
-- for a boot that has acknowledged the current sequence. Additive: lease-v1 boots ignore it.

CREATE TABLE cloud_v2_authority_heads (
  workspace_id uuid PRIMARY KEY REFERENCES cloud_v2_workspaces(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  sequence bigint NOT NULL DEFAULT 0 CHECK (sequence>=0),
  -- A change with no revocation of its own (a non-system Hold/seat/entitlement write) asks the
  -- system to re-evaluate; freshness is withheld from this time until it has.
  recheck_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX cloud_v2_authority_heads_recheck ON cloud_v2_authority_heads(recheck_at) WHERE recheck_at IS NOT NULL;
ALTER TABLE cloud_v2_authority_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_authority_heads FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_authority_heads USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE ON cloud_v2_authority_heads TO zeros_app;

ALTER TABLE cloud_v2_execution_boots
  ADD COLUMN authority_mode text NOT NULL DEFAULT 'lease-v1' CHECK (authority_mode IN ('lease-v1','message-authority-v1')),
  ADD COLUMN authority_acked_sequence bigint NOT NULL DEFAULT 0 CHECK (authority_acked_sequence>=0);

-- Deferred to commit: the head is the last lock a revoking transaction takes, after every context lock, so the
-- UUID-ordered context locking of revokers and fences cannot deadlock on it. Only authority revocations of an R2
-- boot count; a worker's own retirement (revoked then retired in one transaction) never does.
-- Custom GUCs in a function's SET clause require superuser at CREATE time; body-local settings
-- restore the caller's RLS context on every return.
CREATE FUNCTION advance_cloud_authority_head() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE previous_system text := current_setting('app.system',true);
BEGIN
  PERFORM set_config('app.system','on',true);
  IF TG_TABLE_NAME='cloud_v2_execution_contexts' THEN
    -- A worker retires its own context in the same transaction that revokes it.
    IF NOT EXISTS(SELECT 1 FROM public.cloud_v2_execution_contexts c WHERE c.id=NEW.id AND c.state='revoked') THEN
      PERFORM set_config('app.system',coalesce(previous_system,''),true);
      RETURN NULL;
    END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM public.cloud_v2_workspaces w JOIN public.cloud_v2_execution_boots b
        ON b.workspace_id=w.id AND b.boot_id=w.worker_boot_id AND b.authority_mode='message-authority-v1'
        WHERE w.id=NEW.workspace_id) THEN
    INSERT INTO public.cloud_v2_authority_heads(workspace_id,org_id,sequence)
      SELECT w.id,w.org_id,1 FROM public.cloud_v2_workspaces w WHERE w.id=NEW.workspace_id
      ON CONFLICT (workspace_id) DO UPDATE SET sequence=cloud_v2_authority_heads.sequence+1,updated_at=clock_timestamp();
  END IF;
  PERFORM set_config('app.system',coalesce(previous_system,''),true);
  RETURN NULL;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from the new authority trigger functions
REVOKE ALL ON FUNCTION advance_cloud_authority_head() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER authority_head_revoked AFTER UPDATE OF state ON cloud_v2_execution_contexts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.state='active' AND NEW.state='revoked' AND NEW.reason IN ('access_revoked','actor_changed','cancelled'))
  EXECUTE FUNCTION advance_cloud_authority_head();
CREATE CONSTRAINT TRIGGER authority_head_cutoff AFTER INSERT ON cloud_v2_execution_invalidations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION advance_cloud_authority_head();

-- An R2 context never renews, so its person's next clock boundary (a Hold window edge, session or client token
-- expiry, the source answer's 10-minute window) is recorded when it is issued; the barrier never extends past it.
CREATE FUNCTION recheck_cloud_authority_context() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE previous_system text := current_setting('app.system',true); boundary timestamptz;
BEGIN
  PERFORM set_config('app.system','on',true);
  IF EXISTS(SELECT 1 FROM public.cloud_v2_workspaces w JOIN public.cloud_v2_execution_boots b
      ON b.workspace_id=w.id AND b.boot_id=NEW.worker_boot_id AND b.authority_mode='message-authority-v1'
      WHERE w.id=NEW.workspace_id AND w.worker_boot_id=NEW.worker_boot_id) THEN
    boundary := least(clock_timestamp()+interval '10 minutes', NEW.client_token_expires_at,
      (SELECT min(s.provider_session_expires_at) FROM public.auth_sessions s
        WHERE s.user_id=NEW.user_id AND s.provider='workos' AND s.provider_session_id=NEW.provider_session_id),
      (SELECT min(edge) FROM public.organization_member_seat_periods p CROSS JOIN LATERAL unnest(p.hold_periods) r
        CROSS JOIN LATERAL (VALUES (lower(r)),(upper(r))) v(edge)
        WHERE p.org_id=NEW.org_id AND p.user_id IN (NEW.user_id,(NEW.selection#>>'{payer,userId}')::uuid) AND edge>clock_timestamp()));
    INSERT INTO public.cloud_v2_authority_heads(workspace_id,org_id,recheck_at) VALUES(NEW.workspace_id,NEW.org_id,boundary)
      ON CONFLICT (workspace_id) DO UPDATE SET
        recheck_at=least(coalesce(cloud_v2_authority_heads.recheck_at,EXCLUDED.recheck_at),EXCLUDED.recheck_at),updated_at=clock_timestamp();
  END IF;
  PERFORM set_config('app.system',coalesce(previous_system,''),true);
  RETURN NULL;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from the new authority trigger functions
REVOKE ALL ON FUNCTION recheck_cloud_authority_context() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER authority_recheck_context AFTER INSERT ON cloud_v2_execution_contexts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state='active') EXECUTE FUNCTION recheck_cloud_authority_context();

-- Entitlement and seat writes outside a system transaction only NOTIFY today (0245): a lost
-- notification must not let freshness continue, so they mark the affected heads for re-evaluation.
CREATE FUNCTION recheck_cloud_authority_heads() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE person uuid; organization uuid; previous_system text := current_setting('app.system',true);
BEGIN
  IF TG_TABLE_NAME IN ('account_entitlements','staff_pro_benefits') THEN
    person := CASE WHEN TG_OP='DELETE' THEN OLD.user_id ELSE NEW.user_id END;
  ELSIF TG_TABLE_NAME='organization_members' THEN organization := NEW.org_id;
  ELSE organization := NEW.id;
  END IF;
  PERFORM set_config('app.system','on',true);
  INSERT INTO public.cloud_v2_authority_heads(workspace_id,org_id,recheck_at)
    SELECT w.id,w.org_id,clock_timestamp() FROM public.cloud_v2_workspaces w
    WHERE w.execution_mode='active' AND w.state IN ('creating','starting','running')
      AND (w.org_id=organization OR w.org_id IN (SELECT m.org_id FROM public.organization_members m WHERE m.user_id=person))
    ORDER BY w.id
    ON CONFLICT (workspace_id) DO UPDATE SET
      recheck_at=least(coalesce(cloud_v2_authority_heads.recheck_at,EXCLUDED.recheck_at),EXCLUDED.recheck_at),updated_at=clock_timestamp();
  PERFORM set_config('app.system',coalesce(previous_system,''),true);
  RETURN NULL;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from the new authority trigger functions
REVOKE ALL ON FUNCTION recheck_cloud_authority_heads() FROM PUBLIC;
CREATE TRIGGER authority_recheck_entitlement AFTER INSERT OR UPDATE OR DELETE ON account_entitlements
  FOR EACH ROW EXECUTE FUNCTION recheck_cloud_authority_heads();
CREATE TRIGGER authority_recheck_staff_pro AFTER INSERT OR UPDATE OR DELETE ON staff_pro_benefits
  FOR EACH ROW EXECUTE FUNCTION recheck_cloud_authority_heads();
CREATE TRIGGER authority_recheck_seats AFTER INSERT ON organization_members
  FOR EACH ROW EXECUTE FUNCTION recheck_cloud_authority_heads();
CREATE TRIGGER authority_recheck_organization AFTER UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION recheck_cloud_authority_heads();
