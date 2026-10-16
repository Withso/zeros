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

-- Membership epochs (S1 ep.me), per (organization, user). An absent row reads
-- as epoch 1; the first bump creates epoch 2 so a bump always lands above
-- every token issued before it. Bumped by triggers on every membership, role,
-- guest and accepted-invitation change, in the same transaction.
CREATE TABLE cloud_capability_member_epochs (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  epoch bigint NOT NULL CHECK (epoch >= 2),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, user_id)
);

CREATE FUNCTION bump_cloud_capability_member_epoch(target_org uuid, target_user uuid) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO cloud_capability_member_epochs(org_id, user_id, epoch) VALUES (target_org, target_user, 2)
  ON CONFLICT(org_id, user_id) DO UPDATE SET epoch = cloud_capability_member_epochs.epoch + 1,
    updated_at = clock_timestamp();
END $$;

CREATE FUNCTION bump_cloud_capability_member_epoch_trigger() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM bump_cloud_capability_member_epoch(OLD.org_id, OLD.user_id);
  END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    PERFORM bump_cloud_capability_member_epoch(NEW.org_id, NEW.user_id);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER cloud_capability_epoch_org_members
  AFTER INSERT OR UPDATE OF role OR DELETE ON organization_members
  FOR EACH ROW EXECUTE FUNCTION bump_cloud_capability_member_epoch_trigger();
CREATE TRIGGER cloud_capability_epoch_workspace_members
  AFTER INSERT OR UPDATE OF role OR DELETE ON cloud_workspace_members
  FOR EACH ROW EXECUTE FUNCTION bump_cloud_capability_member_epoch_trigger();
CREATE TRIGGER cloud_capability_epoch_guest_grants
  AFTER INSERT OR UPDATE OF role, revoked_at OR DELETE ON cloud_workspace_guest_grants
  FOR EACH ROW EXECUTE FUNCTION bump_cloud_capability_member_epoch_trigger();

-- An invitation is keyed by email, not user; bump once it names an accepted
-- account. Acceptance also writes the guest grant, whose trigger covers the
-- new member; this covers a later revocation of an accepted invitation.
CREATE FUNCTION bump_cloud_capability_invitation_epoch() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.accepted_by IS NOT NULL
     AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.accepted_by IS DISTINCT FROM OLD.accepted_by) THEN
    PERFORM bump_cloud_capability_member_epoch(OLD.org_id, OLD.accepted_by);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER cloud_capability_epoch_invitations
  AFTER UPDATE OF accepted_by, revoked_at ON cloud_workspace_invitations
  FOR EACH ROW EXECUTE FUNCTION bump_cloud_capability_invitation_epoch();

ALTER TABLE cloud_capability_member_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_capability_member_epochs FORCE ROW LEVEL SECURITY;
CREATE POLICY cloud_capability_member_epochs_system ON cloud_capability_member_epochs
  FOR ALL USING (app_is_system()) WITH CHECK (app_is_system());

-- S1 sid: a stable per-session UUID the capability can name without exposing
-- the provider session id.
ALTER TABLE auth_sessions ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX auth_sessions_id_key ON auth_sessions(id);
