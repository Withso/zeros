-- Connected-account native Git extends the existing single-operation grants.
-- No installation write tokens or separate native API proxy leases are stored.
-- Existing system-only RLS and zeros_app grants apply to this additive column.
ALTER TABLE cloud_github_write_grants ADD COLUMN native_request jsonb;
ALTER TABLE cloud_github_write_grants DROP CONSTRAINT cloud_github_write_grants_operation_check;
ALTER TABLE cloud_github_write_grants ADD CONSTRAINT cloud_github_write_grants_operation_check
  CHECK(operation IN ('git.fetch','git.push','gh.prCreate','gh.prUpdate','gh.prMarkReady','gh.prMerge','gh.prComment'));
CREATE UNIQUE INDEX cloud_github_native_request_once
  ON cloud_github_write_grants ((native_request->>'requestId'))
  WHERE native_request IS NOT NULL;

-- Disconnect immediately invalidates in-flight native authority, including
-- grants not yet redeemed. Reconnecting cannot revive a deleted capability.
-- Future operations still require fresh connected-user permission checks;
-- no separate installation credential is introduced.
CREATE FUNCTION revoke_disconnected_native_github_grants()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  DELETE FROM cloud_github_write_grants
  WHERE org_id=OLD.org_id AND actor_user_id=OLD.owner_user_id AND native_request IS NOT NULL;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION revoke_disconnected_native_github_grants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_disconnected_native_github_grants() TO zeros_app;
CREATE TRIGGER revoke_disconnected_native_github_grants
AFTER DELETE ON cloud_github_connections
FOR EACH ROW EXECUTE FUNCTION revoke_disconnected_native_github_grants();
