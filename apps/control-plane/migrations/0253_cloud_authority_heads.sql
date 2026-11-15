-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';
-- R2 message authority (message-authority-v1). Every authority revocation of an R2 boot appends an event in the
-- revoking transaction; the control plane signs worker freshness only for a boot that acknowledged the newest one.
-- Events and re-checks are append-only: no writer updates a shared row, so they add no lock to the UUID-ordered
-- context locking of revokers and fences. Additive: lease-v1 boots ignore all of it.

CREATE SEQUENCE cloud_v2_authority_event_seq;
CREATE TABLE cloud_v2_authority_events (
  id bigint PRIMARY KEY DEFAULT nextval('cloud_v2_authority_event_seq'),
  workspace_id uuid NOT NULL REFERENCES cloud_v2_workspaces(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER SEQUENCE cloud_v2_authority_event_seq OWNED BY cloud_v2_authority_events.id;
CREATE INDEX cloud_v2_authority_events_workspace ON cloud_v2_authority_events(workspace_id,id);
-- A cut with no revocation of its own (a clock boundary, a non-system Hold/seat/entitlement write) asks the system
-- to re-evaluate; freshness is withheld from this time until it has.
CREATE TABLE cloud_v2_authority_rechecks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES cloud_v2_workspaces(id) ON DELETE CASCADE,
  at timestamptz NOT NULL
);
CREATE INDEX cloud_v2_authority_rechecks_workspace ON cloud_v2_authority_rechecks(workspace_id,at);
CREATE INDEX cloud_v2_authority_rechecks_at ON cloud_v2_authority_rechecks(at);
ALTER TABLE cloud_v2_authority_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_authority_events FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_authority_events USING(app_is_system()) WITH CHECK(app_is_system());
ALTER TABLE cloud_v2_authority_rechecks ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_authority_rechecks FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_authority_rechecks USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,DELETE ON cloud_v2_authority_events, cloud_v2_authority_rechecks TO zeros_app;
GRANT USAGE ON SEQUENCE cloud_v2_authority_event_seq TO zeros_app;

ALTER TABLE cloud_v2_execution_boots
  ADD COLUMN authority_mode text NOT NULL DEFAULT 'lease-v1' CHECK (authority_mode IN ('lease-v1','message-authority-v1')),
  ADD COLUMN authority_acked_sequence bigint NOT NULL DEFAULT 0 CHECK (authority_acked_sequence>=0);

-- Only authority revocations of the workspace's current R2 boot count. A worker retiring its own context revokes it
-- first in the same transaction and marks that transaction with app.cloud_authority_retirement.
-- Custom GUCs in a function's SET clause require superuser at CREATE time; body-local settings
-- restore the caller's RLS context on every return.
CREATE FUNCTION record_cloud_authority_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE previous_system text := current_setting('app.system',true);
BEGIN
  IF TG_TABLE_NAME='cloud_v2_execution_contexts' AND coalesce(current_setting('app.cloud_authority_retirement',true),'')='on' THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('app.system','on',true);
  INSERT INTO public.cloud_v2_authority_events(workspace_id)
    SELECT w.id FROM public.cloud_v2_workspaces w JOIN public.cloud_v2_execution_boots b
      ON b.workspace_id=w.id AND b.boot_id=w.worker_boot_id AND b.authority_mode='message-authority-v1'
    WHERE w.id=NEW.workspace_id;
  PERFORM set_config('app.system',coalesce(previous_system,''),true);
  RETURN NULL;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from the new authority trigger functions
REVOKE ALL ON FUNCTION record_cloud_authority_event() FROM PUBLIC;
CREATE TRIGGER authority_event_revoked AFTER UPDATE OF state ON cloud_v2_execution_contexts
  FOR EACH ROW WHEN (OLD.state='active' AND NEW.state='revoked' AND NEW.reason IN ('access_revoked','actor_changed','cancelled'))
  EXECUTE FUNCTION record_cloud_authority_event();
CREATE TRIGGER authority_event_cutoff AFTER INSERT ON cloud_v2_execution_invalidations
  FOR EACH ROW EXECUTE FUNCTION record_cloud_authority_event();

-- An R2 context never renews, so its person's next clock boundary (a Hold window edge, session or client token
-- expiry, the source answer's 10-minute window) is recorded when it is issued; the barrier never extends past it.
CREATE FUNCTION recheck_cloud_authority_context() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE previous_system text := current_setting('app.system',true);
BEGIN
  PERFORM set_config('app.system','on',true);
  INSERT INTO public.cloud_v2_authority_rechecks(workspace_id,at)
    SELECT w.id,least(clock_timestamp()+interval '10 minutes', NEW.client_token_expires_at,
      (SELECT min(s.provider_session_expires_at) FROM public.auth_sessions s
        WHERE s.user_id=NEW.user_id AND s.provider='workos' AND s.provider_session_id=NEW.provider_session_id),
      (SELECT min(edge) FROM public.organization_member_seat_periods p CROSS JOIN LATERAL unnest(p.hold_periods) r
        CROSS JOIN LATERAL (VALUES (lower(r)),(upper(r))) v(edge)
        WHERE p.org_id=NEW.org_id AND p.user_id IN (NEW.user_id,(NEW.selection#>>'{payer,userId}')::uuid) AND edge>clock_timestamp()))
    FROM public.cloud_v2_workspaces w JOIN public.cloud_v2_execution_boots b
      ON b.workspace_id=w.id AND b.boot_id=NEW.worker_boot_id AND b.authority_mode='message-authority-v1'
    WHERE w.id=NEW.workspace_id AND w.worker_boot_id=NEW.worker_boot_id;
  PERFORM set_config('app.system',coalesce(previous_system,''),true);
  RETURN NULL;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from the new authority trigger functions
REVOKE ALL ON FUNCTION recheck_cloud_authority_context() FROM PUBLIC;
CREATE TRIGGER authority_recheck_context AFTER INSERT ON cloud_v2_execution_contexts
  FOR EACH ROW WHEN (NEW.state='active') EXECUTE FUNCTION recheck_cloud_authority_context();

-- Entitlement and seat writes outside a system transaction only NOTIFY today (0245): a lost
-- notification must not let freshness continue, so they mark the affected R2 workspaces for re-evaluation.
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
  INSERT INTO public.cloud_v2_authority_rechecks(workspace_id,at)
    SELECT w.id,clock_timestamp() FROM public.cloud_v2_workspaces w JOIN public.cloud_v2_execution_boots b
      ON b.workspace_id=w.id AND b.boot_id=w.worker_boot_id AND b.authority_mode='message-authority-v1'
    WHERE w.execution_mode='active' AND w.state IN ('creating','starting','running')
      AND (w.org_id=organization OR w.org_id IN (SELECT m.org_id FROM public.organization_members m WHERE m.user_id=person));
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
