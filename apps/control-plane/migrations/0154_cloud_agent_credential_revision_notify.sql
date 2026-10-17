-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Credential-control push (S2 cred.revision): every bump of a boot binding's
-- desired_cache_revision — from any mutation path — notifies the realtime
-- listener, which pushes cred.revision to that engine's uplink. The payload
-- is a hint (engine:revision); the engine's exchange re-reads authority, so
-- a lost or forged notification can only cause a harmless extra exchange.
CREATE FUNCTION notify_cloud_agent_credential_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM pg_notify('zeros_cloud_agent_credential_revision',
    NEW.engine_instance_id::text || ':' || NEW.desired_cache_revision::text);
  RETURN NULL;
END
$$;
CREATE TRIGGER cloud_agent_credential_revision_changed
  AFTER UPDATE OF desired_cache_revision ON cloud_agent_boot_bindings
  FOR EACH ROW WHEN (OLD.desired_cache_revision IS DISTINCT FROM NEW.desired_cache_revision)
  EXECUTE FUNCTION notify_cloud_agent_credential_revision();
