-- A reconnect creates a new authority epoch, even for the same installation.
-- Routine verification preserves it. Existing RLS and zeros_app grants apply.
ALTER TABLE cloud_github_connections
  ADD COLUMN authority_revision uuid NOT NULL DEFAULT gen_random_uuid();

-- Retain the trigger/function name from 0116 for rolling compatibility, but
-- revoke managed grants too. Preparation and use lock the connection first.
CREATE OR REPLACE FUNCTION revoke_disconnected_native_github_grants()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  DELETE FROM cloud_github_write_grants
  WHERE org_id=OLD.org_id AND actor_user_id=OLD.owner_user_id;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION revoke_disconnected_native_github_grants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_disconnected_native_github_grants() TO zeros_app;
