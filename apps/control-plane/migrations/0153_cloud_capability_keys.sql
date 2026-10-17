-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- S1 capability signing keys. Private keys are sealed with the dedicated
-- CLOUD_CAPABILITY_KEYS_JSON keyring (never the settings keyring); the row
-- holds only the envelope. State machine: next -> current -> retiring ->
-- retired, or any state -> revoked. The published set is next, current and
-- retiring, at most one of each.
CREATE TABLE cloud_capability_signing_keys (
  kid text PRIMARY KEY CHECK (kid ~ '^cap-[0-9]{4}-[0-9]{2}-[a-z0-9]{1,16}$'),
  public_jwk jsonb NOT NULL CHECK (
    jsonb_typeof(public_jwk) = 'object'
    AND public_jwk->>'kty' = 'OKP' AND public_jwk->>'crv' = 'Ed25519'
    AND public_jwk->>'x' ~ '^[A-Za-z0-9_-]{43}$'
    AND public_jwk - 'kty' - 'crv' - 'x' = '{}'::jsonb
    AND NOT (public_jwk ?| ARRAY['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth'])
  ),
  key_version integer NOT NULL CHECK (key_version BETWEEN 1 AND 65535),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 4096),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  state text NOT NULL DEFAULT 'next' CHECK (state IN ('next', 'current', 'retiring', 'retired', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  activated_at timestamptz,
  retire_after timestamptz,
  CHECK (state <> 'current' OR activated_at IS NOT NULL),
  CHECK (state NOT IN ('retiring', 'retired') OR retire_after IS NOT NULL)
);
-- At most one key per live state keeps the published set within its 3-key
-- bound; retired and revoked keys accumulate for audit.
CREATE UNIQUE INDEX cloud_capability_signing_one_next
  ON cloud_capability_signing_keys(state) WHERE state = 'next';
CREATE UNIQUE INDEX cloud_capability_signing_one_current
  ON cloud_capability_signing_keys(state) WHERE state = 'current';
CREATE UNIQUE INDEX cloud_capability_signing_one_retiring
  ON cloud_capability_signing_keys(state) WHERE state = 'retiring';

-- An immutable key identity: the sealed bytes, keyring version and public key
-- never change; only the lifecycle state moves.
CREATE FUNCTION preserve_cloud_capability_key() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF ROW(NEW.kid, NEW.public_jwk, NEW.key_version, NEW.nonce, NEW.ciphertext, NEW.auth_tag, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.kid, OLD.public_jwk, OLD.key_version, OLD.nonce, OLD.ciphertext, OLD.auth_tag, OLD.created_at)
    OR OLD.state IN ('retired', 'revoked') AND OLD.state IS DISTINCT FROM NEW.state
    OR (OLD.state = 'current' AND NEW.state NOT IN ('current', 'retiring', 'revoked'))
    OR (OLD.state = 'next' AND NEW.state NOT IN ('next', 'current', 'revoked'))
    OR (OLD.state = 'retiring' AND NEW.state NOT IN ('retiring', 'retired', 'revoked')) THEN
    RAISE EXCEPTION 'capability signing key identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_capability_key_identity
  BEFORE UPDATE ON cloud_capability_signing_keys
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_capability_key();

-- api processes reload the current signing key on this commit-bound hint.
CREATE TRIGGER cloud_capability_keys_changed
  AFTER INSERT OR UPDATE OR DELETE ON cloud_capability_signing_keys
  FOR EACH STATEMENT EXECUTE FUNCTION notify_cloud_worker_available('zeros_capability_keys');

ALTER TABLE cloud_capability_signing_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_capability_signing_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_capability_keys_system_read ON cloud_capability_signing_keys
  FOR SELECT USING (app_is_system());
CREATE POLICY cloud_capability_keys_owner ON cloud_capability_signing_keys
  FOR ALL USING (current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.cloud_capability_signing_keys'::regclass)))
  WITH CHECK (current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.cloud_capability_signing_keys'::regclass)));
-- zeros-expand-exception: new-table-privileges Narrows the default grants of a table created in this migration
REVOKE ALL ON cloud_capability_signing_keys FROM PUBLIC, zeros_app;
GRANT SELECT ON cloud_capability_signing_keys TO zeros_app;

-- Operator audit for signing-key lifecycle changes, the
-- cloud_rollout_flag_changes pattern: one row per executed operation,
-- written in the same transaction; a replayed operation_id naming another
-- change is refused. The runtime role never reads it.
CREATE TABLE cloud_capability_key_changes (
  operation_id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('development','alpha','beta','production')),
  target_sha256 text NOT NULL CHECK (target_sha256 ~ '^[a-f0-9]{64}$'),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  plan_sha256 text NOT NULL CHECK (plan_sha256 ~ '^[a-f0-9]{64}$'),
  transitions jsonb NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 16 AND 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE cloud_capability_key_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_capability_key_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_capability_key_changes_owner ON cloud_capability_key_changes
  FOR ALL USING (current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.cloud_capability_key_changes'::regclass)))
  WITH CHECK (current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.cloud_capability_key_changes'::regclass)));
-- zeros-expand-exception: new-table-privileges Narrows the default grants of a table created in this migration
REVOKE ALL ON cloud_capability_key_changes FROM PUBLIC, zeros_app;

-- Membership epochs (S1 ep.me), per (organization, user). An absent row reads
-- as epoch 1; the first bump creates epoch 2 so a bump always lands above
-- every token issued before it. Bumped in the same transaction by triggers on
-- every table the role functions read (cloud_workspace_actor_role and its
-- callees), so a change that can lower a principal's role or scopes always
-- reaches `me` (capability-epochs.integration.test.ts derives that table set
-- from the live function bodies and fails on an uncovered input):
--   per (org, user): organization_members, cloud_workspace_members,
--     cloud_workspace_guest_grants, team_members (owner branch),
--     organization_seat_assignments, cloud_workspace_writer_slots;
--   per user, in every organization the user belongs to or holds a live
--     guest grant in: users (status, deletion, staff role; skipped when the
--     same update raises auth_revision, which is `ac`), account_entitlements,
--     staff_pro_benefits;
--   every principal of the organization: organizations (deletion, personal),
--     teams (deletion), organization_entitlements, workspace_billing_epochs
--     (scope), cloud_workspaces (owner, sharing, team, billing epoch,
--     deletion; skipped when the same update raises access_revision `wr` or
--     authority_epoch `wa`, which already end every older token), and an
--     active seat beyond the seat limit.
-- Workspace-wide inputs bump `me` per principal instead of `wr` because
-- access_revision also feeds actor fingerprints and funding consents; the
-- fan-out is one row per organization principal on a rare change.
-- Time-based inputs (guest expires_at, entitlement valid_from/valid_until
-- passing) need no bump: S1 caps exp by the guest deadline, and any other
-- deadline passing is bounded by the 300 s token lifetime. A pure
-- valid_until extension is a gain and does not bump.
CREATE TABLE cloud_capability_member_epochs (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  epoch bigint NOT NULL CHECK (epoch >= 2),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, user_id)
);

-- Access loss per workspace (S1 "Snapshot scope"): recorded in the
-- committing transaction when a change removes a principal's access to a
-- workspace, so an auth snapshot lists a removed principal for that
-- workspace only and nothing about other workspaces' members ever reaches
-- a VM. A sharing-mode change bumps wr, which already kills every older
-- token, so it records no rows. Inputs that lower a role without deleting a
-- membership, guest or org-member row keep the principal in the snapshot's
-- current set, so only row removals record a loss. The hourly diagnostics
-- retention pass prunes rows past twice the revocation retention window;
-- readers filter by the window regardless, so the prune bound never affects
-- correctness.
CREATE TABLE cloud_capability_access_losses (
  workspace_id uuid NOT NULL REFERENCES cloud_workspaces(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lost_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX cloud_capability_access_losses_prune ON cloud_capability_access_losses(lost_at);

-- Every write below skips a row whose organization, user or workspace no
-- longer exists. The triggers also fire inside the ON DELETE CASCADE of an
-- Organization or account purge (organization_members, team_members, guest
-- grants, writer slots...), where inserting a row that references the
-- vanishing parent fails its foreign key and rolls the whole purge back.
-- Skipping is safe: a deleted organization, account or workspace leaves no
-- workspace a token could still reach, and the epoch row would be deleted
-- by the same cascade anyway. Rows are written in key order so concurrent
-- fan-outs over one organization cannot deadlock.
CREATE FUNCTION bump_cloud_capability_member_epoch(target_org uuid, target_user uuid) RETURNS void
LANGUAGE sql SET search_path = pg_catalog, public, pg_temp AS $$
  INSERT INTO cloud_capability_member_epochs(org_id, user_id, epoch)
  SELECT target_org, target_user, 2
  WHERE EXISTS (SELECT 1 FROM organizations WHERE id = target_org)
    AND EXISTS (SELECT 1 FROM users WHERE id = target_user)
  ON CONFLICT(org_id, user_id) DO UPDATE SET epoch = cloud_capability_member_epochs.epoch + 1,
    updated_at = clock_timestamp();
$$;

-- Every principal a role in the organization can belong to: members (which
-- include explicit workspace members, owners and seat holders) and live
-- guests.
CREATE FUNCTION bump_cloud_capability_org_epochs(target_org uuid) RETURNS void
LANGUAGE sql SET search_path = pg_catalog, public, pg_temp AS $$
  INSERT INTO cloud_capability_member_epochs(org_id, user_id, epoch)
  SELECT target_org, principal.user_id, 2 FROM (
    SELECT user_id FROM organization_members WHERE org_id = target_org
    UNION
    SELECT user_id FROM cloud_workspace_guest_grants
    WHERE org_id = target_org AND revoked_at IS NULL AND expires_at > clock_timestamp()
  ) principal
  WHERE EXISTS (SELECT 1 FROM organizations WHERE id = target_org)
    AND EXISTS (SELECT 1 FROM users WHERE id = principal.user_id)
  ORDER BY principal.user_id
  ON CONFLICT(org_id, user_id) DO UPDATE SET epoch = cloud_capability_member_epochs.epoch + 1,
    updated_at = clock_timestamp();
$$;

CREATE FUNCTION bump_cloud_capability_user_epochs(target_user uuid) RETURNS void
LANGUAGE sql SET search_path = pg_catalog, public, pg_temp AS $$
  INSERT INTO cloud_capability_member_epochs(org_id, user_id, epoch)
  SELECT scope.org_id, target_user, 2 FROM (
    SELECT org_id FROM organization_members WHERE user_id = target_user
    UNION
    SELECT org_id FROM cloud_workspace_guest_grants
    WHERE user_id = target_user AND revoked_at IS NULL AND expires_at > clock_timestamp()
  ) scope
  WHERE EXISTS (SELECT 1 FROM users WHERE id = target_user)
    AND EXISTS (SELECT 1 FROM organizations WHERE id = scope.org_id)
  ORDER BY scope.org_id
  ON CONFLICT(org_id, user_id) DO UPDATE SET epoch = cloud_capability_member_epochs.epoch + 1,
    updated_at = clock_timestamp();
$$;

CREATE FUNCTION record_cloud_capability_access_loss(target_workspace uuid, target_org uuid, target_user uuid) RETURNS void
LANGUAGE sql SET search_path = pg_catalog, public, pg_temp AS $$
  INSERT INTO cloud_capability_access_losses(workspace_id, org_id, user_id)
  SELECT target_workspace, target_org, target_user
  WHERE EXISTS (SELECT 1 FROM cloud_workspaces WHERE id = target_workspace)
    AND EXISTS (SELECT 1 FROM users WHERE id = target_user)
  ON CONFLICT(workspace_id, user_id) DO UPDATE SET lost_at = clock_timestamp(), org_id = target_org;
$$;

-- The trigger functions are SECURITY DEFINER: the epoch and loss tables are
-- FORCE RLS and system-only, but the source statements also run in user
-- context (a member leaving deletes organization_members under tenant RLS,
-- and app_user_org_ids() loses the organization mid-statement). They run as
-- the migration owner with a pinned search_path, read only OLD/NEW and
-- their own tables, take no caller arguments (trigger functions cannot be
-- called directly) and write nothing but epoch and loss rows, so the
-- elevation cannot be steered by the caller. EXECUTE is revoked from PUBLIC
-- on every function here; the definer keeps it.
CREATE FUNCTION bump_cloud_capability_member_epoch_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  seat_limit integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM bump_cloud_capability_member_epoch(OLD.org_id, OLD.user_id);
    -- Access loss, same transaction as the bump. Membership rows lose access
    -- only on DELETE; a guest grant also loses it when revoked. The
    -- revoked_at probe stays nested: only guest grant rows have it, and SQL
    -- does not promise short-circuit evaluation across record fields.
    IF TG_TABLE_NAME = 'cloud_workspace_members' THEN
      IF TG_OP = 'DELETE' THEN
        PERFORM record_cloud_capability_access_loss(OLD.workspace_id, OLD.org_id, OLD.user_id);
      END IF;
    ELSIF TG_TABLE_NAME = 'cloud_workspace_guest_grants' THEN
      IF TG_OP = 'DELETE' OR (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) THEN
        PERFORM record_cloud_capability_access_loss(OLD.workspace_id, OLD.org_id, OLD.user_id);
      END IF;
    ELSIF TG_TABLE_NAME = 'organization_members' THEN
      IF TG_OP = 'DELETE' THEN
        -- The removed org member loses every organization-shared workspace.
        INSERT INTO cloud_capability_access_losses(workspace_id, org_id, user_id)
          SELECT workspace.id, OLD.org_id, OLD.user_id FROM cloud_workspaces workspace
          WHERE workspace.org_id = OLD.org_id AND workspace.sharing_mode = 'organization' AND workspace.deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id)
          ORDER BY workspace.id
        ON CONFLICT(workspace_id, user_id) DO UPDATE SET lost_at = clock_timestamp(), org_id = OLD.org_id;
      END IF;
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.org_id IS DISTINCT FROM OLD.org_id) THEN
    PERFORM bump_cloud_capability_member_epoch(NEW.org_id, NEW.user_id);
  END IF;
  -- The organization-scope role also requires the active seat count to stay
  -- within the limit, so one more active seat past it lowers everyone.
  IF TG_TABLE_NAME = 'organization_seat_assignments' AND TG_OP <> 'DELETE' THEN
    IF NEW.state = 'active' AND (TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM 'active'
        OR OLD.org_id IS DISTINCT FROM NEW.org_id) THEN
      SELECT entitlement.seat_limit INTO seat_limit FROM organization_entitlements entitlement
      WHERE entitlement.org_id = NEW.org_id;
      IF seat_limit IS NOT NULL AND (SELECT count(*) FROM organization_seat_assignments seat
          WHERE seat.org_id = NEW.org_id AND seat.state = 'active') > seat_limit THEN
        PERFORM bump_cloud_capability_org_epochs(NEW.org_id);
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER cloud_capability_epoch_org_members
  AFTER INSERT OR UPDATE OF role, org_id, user_id OR DELETE ON organization_members
  FOR EACH ROW EXECUTE FUNCTION bump_cloud_capability_member_epoch_trigger();
CREATE TRIGGER cloud_capability_epoch_workspace_members
  AFTER INSERT OR UPDATE OF role, workspace_id, org_id, user_id OR DELETE ON cloud_workspace_members
  FOR EACH ROW EXECUTE FUNCTION bump_cloud_capability_member_epoch_trigger();
CREATE TRIGGER cloud_capability_epoch_guest_grants
  AFTER INSERT OR UPDATE OF role, revoked_at, expires_at, workspace_id, org_id, user_id OR DELETE ON cloud_workspace_guest_grants
  FOR EACH ROW EXECUTE FUNCTION bump_cloud_capability_member_epoch_trigger();
CREATE TRIGGER cloud_capability_epoch_team_members
  AFTER INSERT OR UPDATE OF team_id, org_id, user_id OR DELETE ON team_members
  FOR EACH ROW EXECUTE FUNCTION bump_cloud_capability_member_epoch_trigger();
CREATE TRIGGER cloud_capability_epoch_seat_assignments
  AFTER INSERT OR UPDATE OF state, org_id, user_id OR DELETE ON organization_seat_assignments
  FOR EACH ROW EXECUTE FUNCTION bump_cloud_capability_member_epoch_trigger();

-- Writer slots carry no org_id; the workspace supplies it. A slot cascading
-- away with its workspace finds no workspace and is skipped (see above).
CREATE FUNCTION bump_cloud_capability_writer_slot_epoch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.user_id IS NOT NULL THEN
    PERFORM bump_cloud_capability_member_epoch(workspace.org_id, OLD.user_id)
    FROM cloud_workspaces workspace WHERE workspace.id = OLD.workspace_id;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.user_id IS NOT NULL AND (TG_OP = 'INSERT'
      OR ROW(NEW.workspace_id, NEW.user_id) IS DISTINCT FROM ROW(OLD.workspace_id, OLD.user_id)) THEN
    PERFORM bump_cloud_capability_member_epoch(workspace.org_id, NEW.user_id)
    FROM cloud_workspaces workspace WHERE workspace.id = NEW.workspace_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER cloud_capability_epoch_writer_slots
  AFTER INSERT OR UPDATE OF workspace_id, user_id, invitation_id OR DELETE ON cloud_workspace_writer_slots
  FOR EACH ROW EXECUTE FUNCTION bump_cloud_capability_writer_slot_epoch();

-- Per-user inputs shared by every organization (TG_ARGV[0] names the user
-- column).
CREATE FUNCTION bump_cloud_capability_user_epochs_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  old_user uuid;
  new_user uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_user := (to_jsonb(OLD) ->> TG_ARGV[0])::uuid; END IF;
  IF TG_OP <> 'DELETE' THEN new_user := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid; END IF;
  IF old_user IS NOT NULL THEN PERFORM bump_cloud_capability_user_epochs(old_user); END IF;
  IF new_user IS NOT NULL AND new_user IS DISTINCT FROM old_user THEN
    PERFORM bump_cloud_capability_user_epochs(new_user);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER cloud_capability_epoch_users
  AFTER UPDATE OF auth_status, deleted_at, staff_role ON users
  FOR EACH ROW WHEN (ROW(OLD.auth_status, OLD.deleted_at, OLD.staff_role)
      IS DISTINCT FROM ROW(NEW.auth_status, NEW.deleted_at, NEW.staff_role)
    AND OLD.auth_revision = NEW.auth_revision)
  EXECUTE FUNCTION bump_cloud_capability_user_epochs_trigger('id');
CREATE TRIGGER cloud_capability_epoch_account_entitlements
  AFTER INSERT OR DELETE ON account_entitlements
  FOR EACH ROW EXECUTE FUNCTION bump_cloud_capability_user_epochs_trigger('user_id');
CREATE TRIGGER cloud_capability_epoch_account_entitlement_changes
  AFTER UPDATE ON account_entitlements
  FOR EACH ROW WHEN (ROW(OLD.user_id, OLD.plan, OLD.status, OLD.cloud_workspaces_allowed, OLD.valid_from)
      IS DISTINCT FROM ROW(NEW.user_id, NEW.plan, NEW.status, NEW.cloud_workspaces_allowed, NEW.valid_from)
    OR (NEW.valid_until IS NOT NULL AND (OLD.valid_until IS NULL OR NEW.valid_until < OLD.valid_until)))
  EXECUTE FUNCTION bump_cloud_capability_user_epochs_trigger('user_id');
CREATE TRIGGER cloud_capability_epoch_staff_pro_benefits
  AFTER INSERT OR UPDATE OF user_id, valid_from, revoked_at OR DELETE ON staff_pro_benefits
  FOR EACH ROW EXECUTE FUNCTION bump_cloud_capability_user_epochs_trigger('user_id');

-- Organization-wide inputs (TG_ARGV[0] names the organization column).
CREATE FUNCTION bump_cloud_capability_org_epochs_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  old_org uuid;
  new_org uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_org := (to_jsonb(OLD) ->> TG_ARGV[0])::uuid; END IF;
  IF TG_OP <> 'DELETE' THEN new_org := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid; END IF;
  -- A billing epoch row cascading away with its workspace is skipped: the
  -- deleted workspace leaves nothing to revoke (see above). Nested because
  -- only billing rows have workspace_id and PL/pgSQL resolves every record
  -- field of a condition before evaluating it.
  IF TG_TABLE_NAME = 'workspace_billing_epochs' AND TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM cloud_workspaces WHERE id = OLD.workspace_id) THEN
      RETURN NULL;
    END IF;
  END IF;
  IF old_org IS NOT NULL THEN PERFORM bump_cloud_capability_org_epochs(old_org); END IF;
  IF new_org IS NOT NULL AND new_org IS DISTINCT FROM old_org THEN
    PERFORM bump_cloud_capability_org_epochs(new_org);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER cloud_capability_epoch_organizations
  AFTER UPDATE OF deleted_at, is_personal ON organizations
  FOR EACH ROW WHEN (ROW(OLD.deleted_at, OLD.is_personal) IS DISTINCT FROM ROW(NEW.deleted_at, NEW.is_personal))
  EXECUTE FUNCTION bump_cloud_capability_org_epochs_trigger('id');
-- A team with a workspace cannot be hard-deleted (cloud_workspaces.team_id
-- restricts), so only its soft deletion and moves matter.
CREATE TRIGGER cloud_capability_epoch_teams
  AFTER UPDATE OF id, org_id, deleted_at ON teams
  FOR EACH ROW WHEN (ROW(OLD.id, OLD.org_id, OLD.deleted_at) IS DISTINCT FROM ROW(NEW.id, NEW.org_id, NEW.deleted_at))
  EXECUTE FUNCTION bump_cloud_capability_org_epochs_trigger('org_id');
CREATE TRIGGER cloud_capability_epoch_organization_entitlements
  AFTER INSERT OR DELETE ON organization_entitlements
  FOR EACH ROW EXECUTE FUNCTION bump_cloud_capability_org_epochs_trigger('org_id');
CREATE TRIGGER cloud_capability_epoch_organization_entitlement_changes
  AFTER UPDATE ON organization_entitlements
  FOR EACH ROW WHEN (ROW(OLD.org_id, OLD.plan, OLD.status, OLD.cloud_workspaces_allowed, OLD.seat_limit, OLD.valid_from)
      IS DISTINCT FROM ROW(NEW.org_id, NEW.plan, NEW.status, NEW.cloud_workspaces_allowed, NEW.seat_limit, NEW.valid_from)
    OR (NEW.valid_until IS NOT NULL AND (OLD.valid_until IS NULL OR NEW.valid_until < OLD.valid_until)))
  EXECUTE FUNCTION bump_cloud_capability_org_epochs_trigger('org_id');
CREATE TRIGGER cloud_capability_epoch_billing_epochs
  AFTER UPDATE OF workspace_id, billing_epoch, org_id, entitlement_scope OR DELETE ON workspace_billing_epochs
  FOR EACH ROW EXECUTE FUNCTION bump_cloud_capability_org_epochs_trigger('org_id');
CREATE TRIGGER cloud_capability_epoch_workspaces
  AFTER UPDATE OF owner_user_id, single_member_mode, pro_sharing_ready, sharing_mode, team_id, org_id,
    deleted_at, current_billing_epoch ON cloud_workspaces
  FOR EACH ROW WHEN (ROW(OLD.owner_user_id, OLD.single_member_mode, OLD.pro_sharing_ready, OLD.sharing_mode,
      OLD.team_id, OLD.org_id, OLD.deleted_at, OLD.current_billing_epoch)
      IS DISTINCT FROM ROW(NEW.owner_user_id, NEW.single_member_mode, NEW.pro_sharing_ready, NEW.sharing_mode,
      NEW.team_id, NEW.org_id, NEW.deleted_at, NEW.current_billing_epoch)
    AND OLD.access_revision = NEW.access_revision AND OLD.authority_epoch = NEW.authority_epoch)
  EXECUTE FUNCTION bump_cloud_capability_org_epochs_trigger('org_id');

-- An invitation is keyed by email, not user; bump once it names an accepted
-- account. Acceptance also writes the guest grant, whose trigger covers the
-- new member; this covers a later revocation of an accepted invitation.
CREATE FUNCTION bump_cloud_capability_invitation_epoch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.accepted_by IS NOT NULL
     AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.accepted_by IS DISTINCT FROM OLD.accepted_by) THEN
    PERFORM bump_cloud_capability_member_epoch(OLD.org_id, OLD.accepted_by);
    PERFORM record_cloud_capability_access_loss(OLD.workspace_id, OLD.org_id, OLD.accepted_by);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER cloud_capability_epoch_invitations
  AFTER UPDATE OF accepted_by, revoked_at ON cloud_workspace_invitations
  FOR EACH ROW EXECUTE FUNCTION bump_cloud_capability_invitation_epoch();

-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION bump_cloud_capability_member_epoch(uuid, uuid) FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION bump_cloud_capability_org_epochs(uuid) FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION bump_cloud_capability_user_epochs(uuid) FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION record_cloud_capability_access_loss(uuid, uuid, uuid) FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION bump_cloud_capability_member_epoch_trigger() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION bump_cloud_capability_writer_slot_epoch() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION bump_cloud_capability_user_epochs_trigger() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION bump_cloud_capability_org_epochs_trigger() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION bump_cloud_capability_invitation_epoch() FROM PUBLIC;

-- System readers (issuance, the uplink snapshot) and the diagnostics prune
-- use zeros_app with app.system; the owner policies admit the SECURITY
-- DEFINER triggers even when the migration owner is not a superuser.
ALTER TABLE cloud_capability_member_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_capability_member_epochs FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_capability_member_epochs_system ON cloud_capability_member_epochs
  FOR SELECT USING (app_is_system());
CREATE POLICY cloud_capability_member_epochs_owner ON cloud_capability_member_epochs
  FOR ALL USING (current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.cloud_capability_member_epochs'::regclass)))
  WITH CHECK (current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.cloud_capability_member_epochs'::regclass)));
-- zeros-expand-exception: new-table-privileges Narrows the default grants of a table created in this migration
REVOKE ALL ON cloud_capability_member_epochs FROM PUBLIC, zeros_app;
GRANT SELECT ON cloud_capability_member_epochs TO zeros_app;

ALTER TABLE cloud_capability_access_losses ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_capability_access_losses FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_capability_access_losses_system ON cloud_capability_access_losses
  FOR SELECT USING (app_is_system());
CREATE POLICY cloud_capability_access_losses_system_prune ON cloud_capability_access_losses
  FOR DELETE USING (app_is_system());
CREATE POLICY cloud_capability_access_losses_owner ON cloud_capability_access_losses
  FOR ALL USING (current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.cloud_capability_access_losses'::regclass)))
  WITH CHECK (current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.cloud_capability_access_losses'::regclass)));
-- zeros-expand-exception: new-table-privileges Narrows the default grants of a table created in this migration
REVOKE ALL ON cloud_capability_access_losses FROM PUBLIC, zeros_app;
GRANT SELECT, DELETE ON cloud_capability_access_losses TO zeros_app;

-- S1 sid: a stable per-session UUID the capability can name without exposing
-- the provider session id. The volatile default rewrites auth_sessions under
-- ACCESS EXCLUSIVE; that is deliberate and bounded: the table holds one row
-- per sign-in, lock_timeout is 5 s, and 0121/0029 set the precedent.
ALTER TABLE auth_sessions ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX auth_sessions_id_key ON auth_sessions(id);
