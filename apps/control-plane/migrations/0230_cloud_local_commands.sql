-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

CREATE TABLE local_command_devices (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  provider_session_id text NOT NULL CHECK (char_length(provider_session_id) BETWEEN 1 AND 512),
  registration_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  registration_request_id uuid NOT NULL,
  registration_hash bytea NOT NULL CHECK (octet_length(registration_hash) = 32),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 128),
  reachable_until timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, device_id)
);
CREATE INDEX local_command_devices_session ON local_command_devices(user_id, provider_session_id) WHERE revoked_at IS NULL;

CREATE TABLE cloud_v2_connected_macs (
  workspace_id uuid NOT NULL REFERENCES cloud_v2_workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  device_id uuid NOT NULL,
  registration_id uuid NOT NULL,
  connected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disconnected_at timestamptz,
  is_latest_sender boolean NOT NULL DEFAULT false,
  PRIMARY KEY (workspace_id, user_id, device_id),
  FOREIGN KEY (user_id, device_id) REFERENCES local_command_devices(user_id, device_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX cloud_v2_macs_latest ON cloud_v2_connected_macs(workspace_id,user_id) WHERE is_latest_sender;
CREATE INDEX cloud_v2_macs_device ON cloud_v2_connected_macs(user_id,device_id,registration_id) WHERE disconnected_at IS NULL;

ALTER TABLE cloud_v2_prompt_chats ADD COLUMN local_command_generation bigint NOT NULL DEFAULT 0 CHECK (local_command_generation >= 0);
ALTER TABLE cloud_v2_prompt_outbox
  ADD COLUMN sender_device_id uuid,
  ADD COLUMN sender_registration_id uuid,
  ADD COLUMN sender_binding_generation bigint;
ALTER TABLE organizations ADD COLUMN local_commands_allowed boolean NOT NULL DEFAULT true;
ALTER TABLE cloud_v2_workspaces ADD COLUMN local_command_boot_ids uuid[] NOT NULL DEFAULT '{}'::uuid[] CHECK (cardinality(local_command_boot_ids) <= 2);

CREATE TABLE local_command_requests (
  workspace_id uuid NOT NULL REFERENCES cloud_v2_workspaces(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  chat_id text NOT NULL CHECK (char_length(chat_id) BETWEEN 1 AND 256),
  sender_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  target_device_id uuid,
  target_registration_id uuid,
  target_instance_id uuid,
  target_name text CHECK (target_name IS NULL OR char_length(target_name) BETWEEN 1 AND 128),
  default_mac_name text,
  is_default_target boolean NOT NULL DEFAULT false,
  message_id text,
  message_sequence bigint,
  chat_epoch bigint,
  binding_generation bigint,
  access_epoch bigint NOT NULL,
  stop_generation bigint NOT NULL,
  worker_boot_id uuid NOT NULL,
  execution_id text NOT NULL CHECK (char_length(execution_id) BETWEEN 1 AND 256),
  input_hash bytea NOT NULL CHECK (octet_length(input_hash) = 32),
  input_envelope jsonb,
  input_bytes integer NOT NULL DEFAULT 0 CHECK (input_bytes BETWEEN 0 AND 262144),
  result_envelope jsonb,
  result_hash bytea CHECK (result_hash IS NULL OR octet_length(result_hash) = 32),
  result_summary jsonb CHECK (result_summary IS NULL OR octet_length(result_summary::text) <= 32768),
  output_bytes integer NOT NULL DEFAULT 0 CHECK (output_bytes BETWEEN 0 AND 2097152),
  reserved_output_bytes integer NOT NULL DEFAULT 0 CHECK (reserved_output_bytes IN (0,2097152)),
  phase text NOT NULL CHECK (phase IN ('pending','claimed','terminal')),
  outcome text CHECK (outcome IN ('completed','failed','denied','approval_timed_out','command_timed_out','mac_not_connected','no_target','disabled','cancelled','interrupted')),
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 1 AND 1800000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivery_deadline timestamptz NOT NULL,
  approval_deadline timestamptz NOT NULL,
  run_deadline timestamptz,
  delivered_at timestamptz,
  claimed_at timestamptz,
  terminal_at timestamptz,
  device_ack_at timestamptz,
  output_ack_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,request_id),
  UNIQUE (sender_user_id,request_id),
  CHECK ((phase='terminal') = (outcome IS NOT NULL AND terminal_at IS NOT NULL)),
  CHECK (phase='terminal' OR (sender_user_id IS NOT NULL AND target_device_id IS NOT NULL AND target_registration_id IS NOT NULL
    AND target_instance_id IS NOT NULL AND message_sequence IS NOT NULL AND chat_epoch IS NOT NULL AND binding_generation IS NOT NULL)),
  CHECK (phase<>'claimed' OR (claimed_at IS NOT NULL AND run_deadline IS NOT NULL))
);
CREATE INDEX local_command_requests_device_live ON local_command_requests(sender_user_id,target_device_id,target_registration_id,created_at)
  WHERE device_ack_at IS NULL AND target_device_id IS NOT NULL;
CREATE INDEX local_command_requests_chat_rate ON local_command_requests(workspace_id,chat_id,sender_user_id,created_at);
CREATE INDEX local_command_requests_device_rate ON local_command_requests(sender_user_id,target_device_id,created_at);
CREATE INDEX local_command_requests_live ON local_command_requests(workspace_id,chat_id) WHERE phase IN ('pending','claimed');
CREATE INDEX local_command_requests_deadline ON local_command_requests((CASE WHEN phase='claimed' THEN run_deadline WHEN delivered_at IS NULL THEN delivery_deadline ELSE approval_deadline END))
  WHERE phase IN ('pending','claimed');
CREATE INDEX local_command_requests_retention ON local_command_requests(terminal_at) WHERE input_envelope IS NOT NULL OR result_envelope IS NOT NULL;

ALTER TABLE local_command_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_command_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON local_command_devices USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_v2_connected_macs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_connected_macs FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_connected_macs USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE local_command_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_command_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON local_command_requests USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON local_command_devices,cloud_v2_connected_macs,local_command_requests TO zeros_app;

CREATE FUNCTION notify_local_command_request() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.target_device_id IS NOT NULL THEN
      PERFORM pg_notify('zeros_local_commands', json_build_object('userId',OLD.sender_user_id,'deviceId',OLD.target_device_id)::text);
    END IF;
    PERFORM pg_notify('zeros_local_commands', json_build_object('workspaceId',OLD.workspace_id,'requestId',OLD.request_id)::text);
    RETURN OLD;
  END IF;
  IF NEW.target_device_id IS NOT NULL THEN
    PERFORM pg_notify('zeros_local_commands', json_build_object('userId',NEW.sender_user_id,'deviceId',NEW.target_device_id)::text);
  END IF;
  PERFORM pg_notify('zeros_local_commands', json_build_object('workspaceId',NEW.workspace_id,'requestId',NEW.request_id)::text);
  RETURN NEW;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from the new local-command notification function
REVOKE ALL ON FUNCTION notify_local_command_request() FROM PUBLIC;
CREATE TRIGGER local_command_request_notify AFTER INSERT OR UPDATE OR DELETE ON local_command_requests FOR EACH ROW EXECUTE FUNCTION notify_local_command_request();

CREATE FUNCTION notify_connected_mac() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM pg_notify('zeros_local_commands',json_build_object('userId',OLD.user_id,'deviceId',OLD.device_id)::text);
    RETURN OLD;
  END IF;
  PERFORM pg_notify('zeros_local_commands',json_build_object('userId',NEW.user_id,'deviceId',NEW.device_id)::text);
  RETURN NEW;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from the new connected-Mac notification function
REVOKE ALL ON FUNCTION notify_connected_mac() FROM PUBLIC;
CREATE TRIGGER connected_mac_notify AFTER INSERT OR UPDATE OR DELETE ON cloud_v2_connected_macs FOR EACH ROW EXECUTE FUNCTION notify_connected_mac();

CREATE FUNCTION fence_local_command_sender() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.local_command_requests SET phase='terminal',outcome='cancelled',terminal_at=clock_timestamp(),updated_at=clock_timestamp(),
    reserved_output_bytes=0,result_summary=jsonb_strip_nulls(jsonb_build_object('outcome','cancelled','mac',target_name))
    WHERE workspace_id=NEW.workspace_id AND chat_id=NEW.chat_id AND phase IN ('pending','claimed');
  RETURN NEW;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from the new sender-fencing function
REVOKE ALL ON FUNCTION fence_local_command_sender() FROM PUBLIC;
CREATE TRIGGER local_command_sender_changed AFTER UPDATE OF next_sequence,epoch,local_command_generation ON cloud_v2_prompt_chats
  FOR EACH ROW WHEN (NEW.next_sequence IS DISTINCT FROM OLD.next_sequence OR NEW.epoch IS DISTINCT FROM OLD.epoch OR NEW.local_command_generation IS DISTINCT FROM OLD.local_command_generation)
  EXECUTE FUNCTION fence_local_command_sender();

-- zeros-expand-exception: local-command-erasure Erases only the newly introduced command and connection rows on existing workspace and chat deletion
CREATE FUNCTION erase_local_commands() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME IN ('cloud_v2_prompt_chats','cloud_v2_chats') THEN
    DELETE FROM public.local_command_requests WHERE workspace_id=OLD.workspace_id AND chat_id=OLD.chat_id;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF NEW.state='deleted' THEN
    DELETE FROM public.local_command_requests WHERE workspace_id=NEW.id;
    DELETE FROM public.cloud_v2_connected_macs WHERE workspace_id=NEW.id;
  ELSE
    UPDATE public.local_command_requests SET phase='terminal',outcome='cancelled',terminal_at=clock_timestamp(),updated_at=clock_timestamp(),
      reserved_output_bytes=0,result_summary=jsonb_strip_nulls(jsonb_build_object('outcome','cancelled','mac',target_name))
      WHERE workspace_id=NEW.id AND phase IN ('pending','claimed');
  END IF;
  RETURN NEW;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from the new local-command erasure function
REVOKE ALL ON FUNCTION erase_local_commands() FROM PUBLIC;
CREATE TRIGGER local_command_chat_erasure AFTER DELETE ON cloud_v2_prompt_chats FOR EACH ROW EXECUTE FUNCTION erase_local_commands();
CREATE TRIGGER local_command_mirror_erasure AFTER UPDATE OF deleted_at ON cloud_v2_chats
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION erase_local_commands();
CREATE TRIGGER local_command_mirror_delete AFTER DELETE ON cloud_v2_chats FOR EACH ROW EXECUTE FUNCTION erase_local_commands();
CREATE TRIGGER local_command_workspace_fence AFTER UPDATE OF state,archived_at,access_epoch,stop_generation,worker_boot_id ON cloud_v2_workspaces
  FOR EACH ROW WHEN (NEW.state NOT IN ('creating','starting','running') OR NEW.archived_at IS NOT NULL
    OR NEW.access_epoch IS DISTINCT FROM OLD.access_epoch OR NEW.stop_generation IS DISTINCT FROM OLD.stop_generation OR NEW.worker_boot_id IS DISTINCT FROM OLD.worker_boot_id)
  EXECUTE FUNCTION erase_local_commands();

CREATE FUNCTION fence_local_command_device() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL OR NEW.registration_id IS DISTINCT FROM OLD.registration_id THEN
    UPDATE public.cloud_v2_connected_macs SET disconnected_at=clock_timestamp(),is_latest_sender=false
      WHERE user_id=NEW.user_id AND device_id=NEW.device_id;
    UPDATE public.local_command_requests SET phase='terminal',outcome='cancelled',terminal_at=clock_timestamp(),updated_at=clock_timestamp(),
      reserved_output_bytes=0,result_summary=jsonb_strip_nulls(jsonb_build_object('outcome','cancelled','mac',target_name))
      WHERE sender_user_id=NEW.user_id AND target_device_id=NEW.device_id AND phase IN ('pending','claimed');
  ELSIF NEW.instance_id IS DISTINCT FROM OLD.instance_id THEN
    UPDATE public.local_command_requests SET phase='terminal',outcome='interrupted',terminal_at=clock_timestamp(),updated_at=clock_timestamp(),
      reserved_output_bytes=0,result_summary=jsonb_strip_nulls(jsonb_build_object('outcome','interrupted','mac',target_name))
      WHERE sender_user_id=NEW.user_id AND target_device_id=NEW.device_id AND target_registration_id=NEW.registration_id AND phase='claimed';
    UPDATE public.local_command_requests SET target_instance_id=NEW.instance_id,updated_at=clock_timestamp()
      WHERE sender_user_id=NEW.user_id AND target_device_id=NEW.device_id AND target_registration_id=NEW.registration_id AND phase='pending';
  END IF;
  PERFORM pg_notify('zeros_local_commands',json_build_object('userId',NEW.user_id,'deviceId',NEW.device_id)::text);
  RETURN NEW;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from the new local-command device-fencing function
REVOKE ALL ON FUNCTION fence_local_command_device() FROM PUBLIC;
CREATE TRIGGER local_command_device_fence AFTER UPDATE OF registration_id,instance_id,revoked_at ON local_command_devices
  FOR EACH ROW EXECUTE FUNCTION fence_local_command_device();

CREATE FUNCTION revoke_local_command_session() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.local_command_devices SET revoked_at=clock_timestamp(),reachable_until=NULL,updated_at=clock_timestamp()
    WHERE user_id=NEW.user_id AND provider_session_id=NEW.provider_session_id AND revoked_at IS NULL;
  RETURN NEW;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from the new desktop session-fencing function
REVOKE ALL ON FUNCTION revoke_local_command_session() FROM PUBLIC;
CREATE TRIGGER local_command_session_fence AFTER INSERT OR UPDATE OF status,revoked_at ON auth_sessions
  FOR EACH ROW WHEN (NEW.provider='workos' AND (NEW.status<>'active' OR NEW.revoked_at IS NOT NULL)) EXECUTE FUNCTION revoke_local_command_session();

CREATE FUNCTION change_local_command_setting() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.cloud_v2_workspaces SET login_revision=login_revision+1 WHERE org_id=NEW.id AND state<>'deleted';
  IF NOT NEW.local_commands_allowed THEN
    UPDATE public.local_command_requests r SET phase='terminal',outcome='disabled',terminal_at=clock_timestamp(),updated_at=clock_timestamp(),
      reserved_output_bytes=0,result_summary=jsonb_strip_nulls(jsonb_build_object('outcome','disabled','mac',target_name))
      FROM public.cloud_v2_workspaces w WHERE r.workspace_id=w.id AND w.org_id=NEW.id AND r.phase IN ('pending','claimed');
  END IF;
  PERFORM pg_notify('zeros_cloud_v2_logins',json_build_object('organizationId',NEW.id,'ownerUserId',NULL)::text);
  RETURN NEW;
END;
$$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from the new organization local-command setting function
REVOKE ALL ON FUNCTION change_local_command_setting() FROM PUBLIC;
CREATE TRIGGER local_command_setting_changed AFTER UPDATE OF local_commands_allowed ON organizations
  FOR EACH ROW WHEN (NEW.local_commands_allowed IS DISTINCT FROM OLD.local_commands_allowed) EXECUTE FUNCTION change_local_command_setting();
