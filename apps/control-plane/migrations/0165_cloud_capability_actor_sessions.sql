-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- This mode is selected only after all CP readers and a qualified engine
-- support it. Existing sessions retain their bearer and short renewal rule.
ALTER TABLE cloud_workspace_actor_sessions
  ADD COLUMN session_kind text NOT NULL DEFAULT 'legacy' CHECK (session_kind IN ('legacy', 'capability-v1')),
  ADD COLUMN capability_source_session_id uuid REFERENCES auth_sessions(id) ON DELETE CASCADE,
  ADD COLUMN capability_claims jsonb,
  ADD COLUMN capability_key_id text REFERENCES cloud_capability_signing_keys(kid),
  ADD COLUMN capability_token_sha256 bytea CHECK (octet_length(capability_token_sha256) = 32),
  ADD COLUMN capability_revision bigint CHECK (capability_revision BETWEEN 1 AND 9007199254740991),
  ADD COLUMN capability_route text CHECK (capability_route IN ('direct', 'relay'));

-- zeros-expand-exception: nullable-enrollment Capability rows have no legacy bearer; the kind constraint keeps it mandatory for legacy rows
ALTER TABLE cloud_workspace_actor_sessions ALTER COLUMN token_hash DROP NOT NULL;
-- zeros-expand-exception: widen-check The replacement retains the legacy source check and fences new rows from every N-1 auth reader
ALTER TABLE cloud_workspace_actor_sessions DROP CONSTRAINT cloud_actor_source_session_required;
ALTER TABLE cloud_workspace_actor_sessions ADD CONSTRAINT cloud_actor_source_session_required CHECK (
  session_kind <> 'legacy' OR NOT (revoked_at IS NULL) OR
  num_nulls(auth_provider,auth_subject,auth_session_id,auth_session_created_at) = 0
);
ALTER TABLE cloud_workspace_actor_sessions ADD CONSTRAINT cloud_actor_session_kind_fields CHECK (COALESCE(
  (session_kind = 'legacy' AND octet_length(token_hash) = 32
    AND capability_source_session_id IS NULL AND capability_claims IS NULL AND capability_key_id IS NULL
    AND capability_token_sha256 IS NULL AND capability_revision IS NULL AND capability_route IS NULL)
  OR
  (session_kind = 'capability-v1' AND token_hash IS NULL
    -- N-1 current, recorded and detached readers all require these fields.
    -- A new kind column alone would leave the first 30 seconds unfenced.
    AND auth_provider IS NULL AND auth_subject IS NULL AND auth_session_id IS NULL AND auth_session_created_at IS NULL
    AND num_nulls(capability_source_session_id,capability_key_id,capability_token_sha256,
      capability_revision,capability_route,consumed_at,last_renewed_at) = 0
    AND jsonb_typeof(capability_claims) = 'object'
    AND capability_claims->>'aud' = 'zeros:engine' AND capability_claims->>'knd' = 'client'
    AND capability_claims->>'sub' = 'user:' || actor_user_id::text
    AND capability_claims->>'org' = org_id::text AND capability_claims->>'wsp' = workspace_id::text
    AND (capability_claims->>'gen')::bigint = generation
    AND (NOT capability_claims ? 'ein' OR capability_claims->>'ein' = engine_instance_id::text)
    AND capability_claims->>'sid' = capability_source_session_id::text
    AND capability_claims->>'did' = device_id::text AND capability_claims->>'role' = actor_role
    AND (capability_claims#>>'{ep,wa}')::bigint = authority_epoch
    AND (capability_claims#>>'{ep,dk}')::bigint = device_key_version
    AND jsonb_typeof(capability_claims->'scp') = 'array' AND capability_claims->'scp' ? 'ws:read'
    AND (capability_claims->>'exp')::bigint BETWEEN 1 AND 253402300799
    AND (capability_claims->>'iat')::bigint >= 0
    AND (capability_claims->>'exp')::bigint - (capability_claims->>'iat')::bigint BETWEEN 1 AND 300
    AND (capability_claims->>'nbf')::bigint BETWEEN 0 AND (capability_claims->>'exp')::bigint
    AND capability_claims->>'jti' ~ '^[A-Za-z0-9_-]{22}$'
    AND session_expires_at = to_timestamp((capability_claims->>'exp')::bigint)), false)
);

-- No in-place conversion, authority transfer, expiry rollback or resurrection.
CREATE FUNCTION preserve_cloud_capability_actor_session() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.session_kind IS DISTINCT FROM OLD.session_kind THEN
    RAISE EXCEPTION 'actor session kind is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.session_kind = 'capability-v1' THEN
    IF ROW(NEW.id, NEW.workspace_id, NEW.org_id, NEW.generation, NEW.engine_instance_id,
        NEW.actor_user_id, NEW.device_id, NEW.device_key_version, NEW.authority_epoch, NEW.actor_fingerprint,
        NEW.actor_role, NEW.created_at, NEW.admission_expires_at, NEW.consumed_at,
        NEW.capability_source_session_id, NEW.capability_route)
      IS DISTINCT FROM ROW(OLD.id, OLD.workspace_id, OLD.org_id, OLD.generation, OLD.engine_instance_id,
        OLD.actor_user_id, OLD.device_id, OLD.device_key_version, OLD.authority_epoch, OLD.actor_fingerprint,
        OLD.actor_role, OLD.created_at, OLD.admission_expires_at, OLD.consumed_at,
        OLD.capability_source_session_id, OLD.capability_route)
      OR (NEW.capability_claims - ARRAY['iat','nbf','exp','jti'])
        IS DISTINCT FROM (OLD.capability_claims - ARRAY['iat','nbf','exp','jti'])
      OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
      RAISE EXCEPTION 'capability actor binding is immutable' USING ERRCODE = '23514';
    END IF;
    IF ROW(NEW.capability_claims, NEW.capability_key_id, NEW.capability_token_sha256,
        NEW.capability_revision, NEW.session_expires_at)
      IS DISTINCT FROM ROW(OLD.capability_claims, OLD.capability_key_id, OLD.capability_token_sha256,
        OLD.capability_revision, OLD.session_expires_at) THEN
      IF OLD.revoked_at IS NOT NULL OR NEW.capability_revision <> OLD.capability_revision + 1
        OR NEW.session_expires_at <= OLD.session_expires_at OR NEW.session_expires_at <= clock_timestamp()
        OR (NEW.capability_claims->>'iat')::bigint < (OLD.capability_claims->>'iat')::bigint
        OR NEW.capability_claims->>'jti' = OLD.capability_claims->>'jti' THEN
        RAISE EXCEPTION 'capability actor renewal must advance' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_capability_actor_session_identity BEFORE UPDATE ON cloud_workspace_actor_sessions
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_capability_actor_session();

-- The application can read keys but cannot UPDATE them (including SELECT
-- FOR SHARE). This narrow mutation fence locks at most two public key rows
-- during renewal without granting access to their sealed private material.
CREATE FUNCTION cloud_capability_actor_signing_keys_live(kids text[]) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE locked_count integer;
BEGIN
  IF app_is_system() IS NOT TRUE OR coalesce(cardinality(kids),0) NOT BETWEEN 1 AND 2 THEN RETURN false; END IF;
  SELECT count(*) INTO locked_count FROM (
    SELECT kid FROM cloud_capability_signing_keys WHERE kid = ANY(kids)
      AND (state = 'current' OR (state = 'retiring' AND retire_after > clock_timestamp()))
    ORDER BY kid FOR SHARE
  ) locked;
  RETURN locked_count = cardinality(kids);
END $$;

-- Common source predicate for current sessions and recorded accepted work.
-- Disconnect/interactive expiry do not erase recorded work. Source auth,
-- device, scope, epochs and key revocation still fence both kinds of use.
CREATE FUNCTION cloud_workspace_actor_session_source_live(
  session cloud_workspace_actor_sessions, required_scope text, current_session boolean, capability_enabled boolean
) RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT app_is_system() AND COALESCE(CASE session.session_kind
    WHEN 'legacy' THEN
      cloud_workspace_actor_auth_live(session.actor_user_id,session.auth_provider,session.auth_subject,
        session.auth_session_id,session.auth_session_created_at)
      AND (NOT current_session OR (session.revoked_at IS NULL AND session.consumed_at IS NOT NULL
        AND session.session_expires_at > clock_timestamp()
        AND session.last_renewed_at > clock_timestamp() - interval '30 seconds'))
    WHEN 'capability-v1' THEN
      session.consumed_at IS NOT NULL AND session.capability_claims->'scp' ? required_scope
      AND (NOT current_session OR (capability_enabled AND session.revoked_at IS NULL
        AND session.session_expires_at > clock_timestamp()))
      AND EXISTS (
        SELECT 1 FROM auth_sessions source
        JOIN users account ON account.id = source.user_id
        JOIN devices device ON device.id = session.device_id AND device.user_id = session.actor_user_id
        JOIN cloud_workspaces workspace ON workspace.id = session.workspace_id AND workspace.org_id = session.org_id
        JOIN cloud_capability_signing_keys signing ON signing.kid = session.capability_key_id
        WHERE source.id = session.capability_source_session_id AND source.user_id = session.actor_user_id
          AND cloud_workspace_actor_auth_live(source.user_id,source.provider,source.provider_sub,source.provider_session_id,source.created_at)
          AND (source.provider_session_expires_at IS NULL OR source.provider_session_expires_at > clock_timestamp())
          AND device.trust_state = 'trusted' AND device.revoked_at IS NULL AND device.key_version = session.device_key_version
          AND rtrim(translate(encode(device.public_key,'base64'),'+/','-_'),'=') = session.capability_claims#>>'{cnf,jwk,x}'
          AND workspace.deleted_at IS NULL AND workspace.authority_epoch = session.authority_epoch
          AND workspace.access_revision = (session.capability_claims#>>'{ep,wr}')::bigint
          AND account.auth_revision = (session.capability_claims#>>'{ep,ac}')::bigint
          AND coalesce((SELECT epoch FROM cloud_capability_member_epochs member
            WHERE member.org_id = session.org_id AND member.user_id = session.actor_user_id),1)
              = (session.capability_claims#>>'{ep,me}')::bigint
          AND cloud_workspace_actor_role(session.workspace_id,session.actor_user_id) = session.actor_role
          AND cloud_workspace_actor_fingerprint(session.workspace_id,session.actor_user_id) = session.actor_fingerprint
          AND (signing.state = 'current' OR (signing.state = 'retiring' AND signing.retire_after > clock_timestamp()))
          AND (NOT current_session OR (workspace.current_generation = session.generation AND workspace.desired_state = 'running'
            AND EXISTS (SELECT 1 FROM cloud_workspace_engine_instances engine
              WHERE engine.id = session.engine_instance_id AND engine.workspace_id = session.workspace_id
                AND engine.org_id = session.org_id AND engine.generation = session.generation
                AND engine.state = 'ready' AND engine.revoked_at IS NULL AND engine.final_checkpoint_at IS NULL
                AND engine.lease_expires_at > clock_timestamp())))
      )
    ELSE false END, false)
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION preserve_cloud_capability_actor_session() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION cloud_capability_actor_signing_keys_live(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_capability_actor_signing_keys_live(text[]) TO zeros_app;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE from a function created in this migration
REVOKE ALL ON FUNCTION cloud_workspace_actor_session_source_live(cloud_workspace_actor_sessions, text, boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud_workspace_actor_session_source_live(cloud_workspace_actor_sessions, text, boolean, boolean) TO zeros_app;
