-- ───────────────────────────────────────────────────────────
-- 0040 — per-device localhost-forward lifecycle authority
--
-- One provider SSH grant owns at most one local-forward session. Grant
-- revocation/expiry is reflected transactionally so operational views never
-- report a device tunnel as live after its remote authority ended.
-- ───────────────────────────────────────────────────────────

ALTER TABLE port_forward_sessions
  ADD CONSTRAINT port_forward_sessions_access_grant_unique
  UNIQUE (access_grant_id);

CREATE INDEX workspace_ports_current_observation_idx
  ON workspace_ports(workspace_id, generation, health, port);

CREATE FUNCTION sync_port_forward_session_access_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind <> 'tunnel' OR NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;

  IF NEW.state IN ('revocation_pending', 'revoked') THEN
    UPDATE port_forward_sessions
    SET state = CASE
          WHEN NEW.expires_at IS NOT NULL AND NEW.expires_at <= now()
            THEN 'expired'
          ELSE 'stopped'
        END,
        stopped_at = coalesce(stopped_at, now()),
        updated_at = now()
    WHERE access_grant_id = NEW.id
      AND state IN ('starting', 'active');
  ELSIF NEW.state = 'failed' THEN
    UPDATE port_forward_sessions
    SET state = 'failed', stopped_at = coalesce(stopped_at, now()),
        updated_at = now()
    WHERE access_grant_id = NEW.id
      AND state IN ('starting', 'active');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cloud_workspace_access_sync_port_forward
AFTER UPDATE OF state ON cloud_workspace_client_access_grants
FOR EACH ROW EXECUTE FUNCTION sync_port_forward_session_access_state();

-- Revoking one Mac/device must immediately fence its local forwards and queue
-- the provider's bearer-free SSH drain. The access worker later records the
-- provider-wide effect for sibling grants on the same sandbox generation.
CREATE FUNCTION revoke_port_forward_access_for_device() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.trust_state <> 'revoked' AND NEW.trust_state = 'revoked' THEN
    UPDATE cloud_workspace_client_access_grants access
    SET state = 'revocation_pending', revocation_reason = 'device_revoked',
        next_revocation_at = now(), updated_at = now()
    FROM port_forward_sessions session
    WHERE session.device_id = NEW.id
      AND session.access_grant_id = access.id
      AND access.kind = 'tunnel'
      AND access.state = 'active';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER device_port_forward_access_revoke
AFTER UPDATE OF trust_state ON devices
FOR EACH ROW EXECUTE FUNCTION revoke_port_forward_access_for_device();

REVOKE ALL ON FUNCTION sync_port_forward_session_access_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_port_forward_access_for_device() FROM PUBLIC;
