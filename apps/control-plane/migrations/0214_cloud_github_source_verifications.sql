-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Permission observations contain no credential. They let an already admitted
-- workspace retain a bounded grant through a GitHub outage, including when a
-- request reaches a different API replica. New admission still requires a
-- fresh observation. The exact actor generation and immutable repository ID
-- must match on every use; membership removal deletes the observation.
CREATE TABLE cloud_github_source_verifications (
  org_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  repository_id bigint NOT NULL CHECK (repository_id BETWEEN 1 AND 9007199254740991),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  verified_at timestamptz,
  canonical_repository text CHECK (canonical_repository ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
  failure_code text CHECK (length(failure_code) <= 100),
  failure_status integer CHECK (failure_status BETWEEN 400 AND 599),
  failures integer NOT NULL DEFAULT 0 CHECK (failures BETWEEN 0 AND 16),
  retry_at timestamptz,
  claim_id uuid,
  claim_started_at timestamptz,
  claim_until timestamptz,
  PRIMARY KEY (org_id, owner_user_id, repository_id),
  FOREIGN KEY (org_id, owner_user_id) REFERENCES organization_members(org_id, user_id) ON DELETE CASCADE,
  CHECK ((failure_code IS NULL) = (failure_status IS NULL)),
  CHECK ((claim_id IS NULL) = (claim_started_at IS NULL) AND (claim_id IS NULL) = (claim_until IS NULL))
);
CREATE INDEX cloud_github_source_verifications_backoff
  ON cloud_github_source_verifications(org_id,owner_user_id,fingerprint,retry_at DESC)
  WHERE failure_code IN ('github_rate_limited','github_unavailable');
ALTER TABLE cloud_github_source_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_github_source_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_github_source_verifications USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON cloud_github_source_verifications TO zeros_app;

-- A delayed permission refresh must not undo a newer verified rename.
ALTER TABLE cloud_v2_github_workspaces ADD COLUMN repository_observed_at timestamptz;
UPDATE cloud_v2_github_workspaces SET repository_observed_at=updated_at WHERE repository_id IS NOT NULL;
