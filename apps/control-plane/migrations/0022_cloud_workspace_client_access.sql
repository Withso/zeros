-- ───────────────────────────────────────────────────────────
-- 0022 — Revocable client SSH, tunnel, and preview capabilities
--
-- Provider and Zeros bearer values are returned once and represented here
-- only by SHA-256 verifiers. Provider-wide SSH revocation is durable work:
-- lifecycle/member changes move grants to revocation_pending and a fenced
-- worker proves provider revocation before publishing `revoked`.
-- ───────────────────────────────────────────────────────────

CREATE TYPE cloud_workspace_client_access_kind AS ENUM (
  'ssh',
  'tunnel',
  'preview'
);

CREATE TYPE cloud_workspace_client_access_state AS ENUM (
  'issuing',
  'active',
  'revocation_pending',
  'revoked',
  'failed'
);

CREATE TABLE cloud_workspace_client_access_grants (
  id                        uuid PRIMARY KEY,
  workspace_id              uuid NOT NULL,
  generation                integer NOT NULL CHECK (generation > 0),
  org_id                    uuid NOT NULL,
  account_user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                      cloud_workspace_client_access_kind NOT NULL,
  remote_port               integer,
  provider_resource_id      text NOT NULL CHECK (
                              char_length(provider_resource_id) BETWEEN 1 AND 512
                            ),
  provider_access_id        text CHECK (
                              provider_access_id IS NULL
                              OR char_length(provider_access_id) BETWEEN 1 AND 512
                            ),
  preview_proxy_label       text UNIQUE CHECK (
                              preview_proxy_label IS NULL
                              OR preview_proxy_label ~ '^[a-f0-9]{32}$'
                            ),
  token_hash                bytea UNIQUE CHECK (
                              token_hash IS NULL OR octet_length(token_hash) = 32
                            ),
  idempotency_key           text NOT NULL CHECK (
                              idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'
                            ),
  request_sha256            bytea NOT NULL CHECK (
                              octet_length(request_sha256) = 32
                            ),
  state                     cloud_workspace_client_access_state NOT NULL
                            DEFAULT 'issuing',
  requested_expires_at      timestamptz NOT NULL,
  expires_at                timestamptz,
  issued_at                 timestamptz,
  revocation_reason         text CHECK (
                              revocation_reason IS NULL
                              OR char_length(revocation_reason) <= 128
                            ),
  revocation_attempt_count  integer NOT NULL DEFAULT 0 CHECK (
                              revocation_attempt_count >= 0
                            ),
  revocation_lease_owner    text CHECK (
                              revocation_lease_owner IS NULL
                              OR char_length(revocation_lease_owner)
                                   BETWEEN 1 AND 255
                            ),
  revocation_lease_expires_at timestamptz,
  next_revocation_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at                timestamptz,
  error_code                text CHECK (
                              error_code IS NULL OR char_length(error_code) <= 128
                            ),
  error_message             text CHECK (
                              error_message IS NULL
                              OR char_length(error_message) <= 2048
                            ),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, account_user_id, idempotency_key),
  FOREIGN KEY (workspace_id, generation, org_id)
    REFERENCES cloud_workspace_generations(workspace_id, generation, org_id)
    ON DELETE CASCADE,
  CHECK (requested_expires_at > created_at),
  CHECK (
    (kind = 'ssh' AND remote_port IS NULL AND preview_proxy_label IS NULL)
    OR
    (kind = 'tunnel' AND remote_port BETWEEN 1024 AND 65535
      AND remote_port <> 22222 AND preview_proxy_label IS NULL)
    OR
    (kind = 'preview' AND remote_port BETWEEN 1024 AND 65535
      AND remote_port <> 22222 AND preview_proxy_label IS NOT NULL
      AND provider_access_id IS NULL)
  ),
  CHECK (
    (state = 'issuing' AND token_hash IS NULL AND expires_at IS NULL
      AND issued_at IS NULL AND revoked_at IS NULL)
    OR
    (state = 'active' AND token_hash IS NOT NULL
      AND expires_at IS NOT NULL AND issued_at IS NOT NULL
      AND revoked_at IS NULL)
    OR
    (state = 'revocation_pending' AND revoked_at IS NULL)
    OR
    (state = 'revoked' AND revoked_at IS NOT NULL)
    OR
    (state = 'failed' AND revoked_at IS NULL)
  ),
  CHECK (expires_at IS NULL OR expires_at > created_at),
  CHECK (issued_at IS NULL OR issued_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (
    (revocation_lease_owner IS NULL) =
      (revocation_lease_expires_at IS NULL)
  )
);

CREATE INDEX cloud_workspace_client_access_live_idx
  ON cloud_workspace_client_access_grants (
    workspace_id, generation, kind, expires_at
  )
  WHERE state IN ('active', 'revocation_pending');
CREATE INDEX cloud_workspace_client_access_revoke_idx
  ON cloud_workspace_client_access_grants (
    next_revocation_at, created_at, id
  )
  WHERE state = 'revocation_pending';
CREATE INDEX cloud_workspace_client_access_stale_issue_idx
  ON cloud_workspace_client_access_grants (created_at, id)
  WHERE state = 'issuing';

-- Authorization loss immediately blocks preview proxy use and schedules
-- provider-wide SSH invalidation. Offline bytes already copied to a client are
-- outside this capability boundary.
CREATE FUNCTION revoke_cloud_workspace_access_for_org_member()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE cloud_workspace_client_access_grants
  SET state = 'revocation_pending',
      revocation_reason = 'organization_membership_removed',
      next_revocation_at = now(), updated_at = now()
  WHERE org_id = OLD.org_id AND account_user_id = OLD.user_id
    AND state = 'active';
  RETURN OLD;
END;
$$;

CREATE TRIGGER organization_member_cloud_workspace_access_revoke
  AFTER DELETE ON organization_members
  FOR EACH ROW EXECUTE FUNCTION revoke_cloud_workspace_access_for_org_member();

CREATE FUNCTION revoke_cloud_workspace_access_for_team_member()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE cloud_workspace_client_access_grants access
  SET state = 'revocation_pending',
      revocation_reason = 'team_membership_removed',
      next_revocation_at = now(), updated_at = now()
  FROM cloud_workspaces workspace
  WHERE workspace.id = access.workspace_id
    AND workspace.org_id = access.org_id
    AND workspace.team_id = OLD.team_id
    AND access.org_id = OLD.org_id
    AND access.account_user_id = OLD.user_id
    AND access.state = 'active';
  RETURN OLD;
END;
$$;

CREATE TRIGGER team_member_cloud_workspace_access_revoke
  AFTER DELETE ON team_members
  FOR EACH ROW EXECUTE FUNCTION revoke_cloud_workspace_access_for_team_member();

ALTER TABLE cloud_workspace_client_access_grants ENABLE ROW LEVEL SECURITY;

-- Verifiers and provider ids remain coordinator-only. Public documents are
-- built by the access service after an explicit authorization decision.
CREATE POLICY cloud_workspace_client_access_system
  ON cloud_workspace_client_access_grants FOR ALL
  USING (app_is_system()) WITH CHECK (app_is_system());

ALTER TABLE cloud_workspace_client_access_grants FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON cloud_workspace_client_access_grants TO zeros_app;
