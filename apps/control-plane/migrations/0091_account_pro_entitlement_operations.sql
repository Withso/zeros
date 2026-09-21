-- Individual Pro access is separate from staff roles, organization metadata,
-- and compute credits. The owner-only operator records every explicit change.
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON account_entitlements FROM zeros_app;
CREATE TABLE account_pro_entitlement_changes (
  operation_id uuid PRIMARY KEY,
  change_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  subject_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  deployment_channel text NOT NULL CHECK (deployment_channel IN ('development','alpha','beta','production')),
  target_sha256 text NOT NULL CHECK (target_sha256 ~ '^[a-f0-9]{64}$'),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  plan_sha256 text NOT NULL CHECK (plan_sha256 ~ '^[a-f0-9]{64}$'),
  previous_state jsonb NOT NULL CHECK (jsonb_typeof(previous_state) IN ('object','null')),
  next_state jsonb NOT NULL CHECK (jsonb_typeof(next_state)='object'),
  database_principal text NOT NULL CHECK (length(database_principal) BETWEEN 1 AND 128),
  reason text NOT NULL CHECK (length(reason) BETWEEN 16 AND 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX account_pro_entitlement_changes_subject_revision
  ON account_pro_entitlement_changes(subject_user_id,change_sequence DESC);
ALTER TABLE account_pro_entitlement_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_pro_entitlement_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY account_pro_entitlement_changes_owner ON account_pro_entitlement_changes
  FOR ALL USING(current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.account_pro_entitlement_changes'::regclass)))
  WITH CHECK(current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.account_pro_entitlement_changes'::regclass)));
CREATE FUNCTION reject_account_pro_entitlement_change_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE'
     AND current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
     AND EXISTS(SELECT 1 FROM public.users WHERE id IN (OLD.subject_user_id,OLD.actor_user_id) AND auth_status='deleted') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'account_pro_entitlement_changes is append-only' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER account_pro_entitlement_changes_append_only
  BEFORE UPDATE OR DELETE ON account_pro_entitlement_changes FOR EACH ROW
  EXECUTE FUNCTION reject_account_pro_entitlement_change_mutation();
CREATE TRIGGER account_pro_entitlement_changes_no_truncate
  BEFORE TRUNCATE ON account_pro_entitlement_changes FOR EACH STATEMENT
  EXECUTE FUNCTION reject_account_pro_entitlement_change_mutation();
REVOKE ALL ON account_pro_entitlement_changes FROM PUBLIC,zeros_app;
REVOKE ALL ON FUNCTION reject_account_pro_entitlement_change_mutation() FROM PUBLIC;

-- Account deletion retains an anonymized UUID tombstone. A foreign-key cascade
-- therefore cannot implement erasure; the lifecycle calls this after anonymizing.
CREATE FUNCTION purge_account_pro_configuration(p_user_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NOT public.app_is_system() THEN
    RAISE EXCEPTION 'system context required' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM public.users WHERE id=p_user_id AND auth_status='deleted' AND deleted_at IS NOT NULL FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account purge state mismatch' USING ERRCODE='55000';
  END IF;
  DELETE FROM public.account_pro_entitlement_changes WHERE subject_user_id=p_user_id OR actor_user_id=p_user_id;
  DELETE FROM public.account_entitlements WHERE user_id=p_user_id;
END;
$$;
REVOKE ALL ON FUNCTION purge_account_pro_configuration(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_account_pro_configuration(uuid) TO zeros_app;
