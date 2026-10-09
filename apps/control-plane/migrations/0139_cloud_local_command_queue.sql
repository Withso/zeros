-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- The local dispatcher and the legacy CP queue are distinct authorities. These
-- tables are a read-only history projection; no CP claim query reads them.
CREATE TABLE cloud_workspace_local_command_writers (
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  engine_instance_id uuid NOT NULL,
  boot_id uuid NOT NULL,
  writer_epoch uuid NOT NULL,
  funding_owner_user_id uuid NOT NULL REFERENCES users(id),
  funding_owner_epoch bigint NOT NULL CHECK (funding_owner_epoch > 0),
  mode text NOT NULL DEFAULT 'boot-owner-v1' CHECK (mode = 'boot-owner-v1'),
  funding_scope text NOT NULL DEFAULT 'workspace-roles-v1' CHECK (funding_scope = 'workspace-roles-v1'),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','active','retired')),
  mirrored_sequence bigint NOT NULL DEFAULT 0 CHECK (mirrored_sequence >= 0),
  sealed_sequence bigint CHECK (sealed_sequence >= 0 AND sealed_sequence <= mirrored_sequence),
  seal_record_sequence bigint CHECK (seal_record_sequence >= 0),
  seal_event_sequence bigint CHECK (seal_event_sequence >= 0),
  seal jsonb,
  seal_ack jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  retired_at timestamptz,
  PRIMARY KEY (workspace_id,writer_epoch),
  UNIQUE (workspace_id,writer_epoch,org_id),
  UNIQUE (workspace_id,engine_instance_id,boot_id),
  FOREIGN KEY (workspace_id,org_id) REFERENCES cloud_workspaces(id,org_id) ON DELETE CASCADE,
  FOREIGN KEY (engine_instance_id,workspace_id,generation,org_id)
    REFERENCES cloud_workspace_engine_instances(id,workspace_id,generation,org_id) ON DELETE RESTRICT,
  CHECK ((state='reserved')=(activated_at IS NULL)),
  CHECK ((state='retired')=(retired_at IS NOT NULL)),
  CHECK (num_nonnulls(sealed_sequence,seal_record_sequence,seal_event_sequence,seal,seal_ack) IN (0,5)),
  CHECK (seal IS NULL OR ((state IN ('active','retired') AND jsonb_typeof(seal)='object' AND pg_column_size(seal)<=4096
    AND (seal - ARRAY['version','scope','sealId','sequence','recordSequence','eventSequence','inventorySha256','sha256']::text[])='{}'::jsonb
    AND jsonb_typeof(seal->'version')='number' AND seal->>'version'='1'
    AND jsonb_typeof(seal->'sealId')='string' AND seal->>'sealId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    AND jsonb_typeof(seal->'sequence')='number' AND (seal->>'sequence')::numeric=sealed_sequence
    AND jsonb_typeof(seal->'recordSequence')='number' AND (seal->>'recordSequence')::numeric=seal_record_sequence
    AND jsonb_typeof(seal->'eventSequence')='number' AND (seal->>'eventSequence')::numeric=seal_event_sequence
    AND sealed_sequence<=9007199254740991 AND seal_record_sequence<=9007199254740991 AND seal_event_sequence<=9007199254740991
    AND jsonb_typeof(seal->'inventorySha256')='string' AND seal->>'inventorySha256' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(seal->'sha256')='string' AND seal->>'sha256' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(seal->'scope')='object'
    AND ((seal->'scope') - ARRAY['organizationId','workspaceId','generation','engineInstanceId','bootId','writerEpoch','fundingOwnerUserId','fundingOwnerEpoch']::text[])='{}'::jsonb
    AND jsonb_typeof(seal->'scope'->'organizationId')='string' AND seal->'scope'->>'organizationId'=org_id::text
    AND jsonb_typeof(seal->'scope'->'workspaceId')='string' AND seal->'scope'->>'workspaceId'=workspace_id::text
    AND jsonb_typeof(seal->'scope'->'generation')='number' AND (seal->'scope'->>'generation')::numeric=generation
    AND jsonb_typeof(seal->'scope'->'engineInstanceId')='string' AND seal->'scope'->>'engineInstanceId'=engine_instance_id::text
    AND jsonb_typeof(seal->'scope'->'bootId')='string' AND seal->'scope'->>'bootId'=boot_id::text
    AND jsonb_typeof(seal->'scope'->'writerEpoch')='string' AND seal->'scope'->>'writerEpoch'=writer_epoch::text
    AND jsonb_typeof(seal->'scope'->'fundingOwnerUserId')='string' AND seal->'scope'->>'fundingOwnerUserId'=funding_owner_user_id::text
    AND jsonb_typeof(seal->'scope'->'fundingOwnerEpoch')='number' AND (seal->'scope'->>'fundingOwnerEpoch')::numeric=funding_owner_epoch
    AND jsonb_typeof(seal_ack)='object' AND pg_column_size(seal_ack)<=4096
    AND seal_ack=(seal - 'scope') || jsonb_build_object('writerEpoch',writer_epoch)) IS TRUE))
);
CREATE FUNCTION preserve_cloud_local_writer_seal() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF OLD.seal IS NOT NULL AND (NEW.seal IS DISTINCT FROM OLD.seal OR NEW.seal_ack IS DISTINCT FROM OLD.seal_ack
    OR NEW.sealed_sequence IS DISTINCT FROM OLD.sealed_sequence OR NEW.seal_record_sequence IS DISTINCT FROM OLD.seal_record_sequence
    OR NEW.seal_event_sequence IS DISTINCT FROM OLD.seal_event_sequence OR NEW.mirrored_sequence IS DISTINCT FROM OLD.mirrored_sequence) THEN
    RAISE EXCEPTION 'immutable local writer seal' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_local_writer_seal_immutable BEFORE UPDATE ON cloud_workspace_local_command_writers
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_local_writer_seal();
CREATE UNIQUE INDEX cloud_local_command_single_writer ON cloud_workspace_local_command_writers(workspace_id)
  WHERE state='active';

CREATE TABLE cloud_workspace_local_command_controls (
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  writer_epoch uuid NOT NULL,
  conversation_id text NOT NULL CHECK (conversation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  revision bigint NOT NULL CHECK (revision >= 0),
  paused boolean NOT NULL,
  native_goal jsonb CHECK (native_goal IS NULL OR (jsonb_typeof(native_goal)='object' AND octet_length(native_goal::text)<=65536)),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,writer_epoch,conversation_id),
  UNIQUE (workspace_id,writer_epoch,conversation_id,org_id),
  FOREIGN KEY (workspace_id,writer_epoch,org_id)
    REFERENCES cloud_workspace_local_command_writers(workspace_id,writer_epoch,org_id) ON DELETE CASCADE
);

CREATE TABLE cloud_workspace_local_commands (
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  id uuid NOT NULL,
  conversation_id text NOT NULL CHECK (conversation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  -- Origin survives recovery projection into another engine writer. It keeps
  -- the actual funding owner and generation in audit instead of rebinding it.
  writer_epoch uuid NOT NULL,
  projection_epoch uuid NOT NULL,
  user_message_id text NOT NULL CHECK (user_message_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  agent_id text NOT NULL CHECK (agent_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  position bigint NOT NULL CHECK (position > 0),
  state text NOT NULL CHECK (state IN ('queued','dispatching','succeeded','failed','cancelled','uncertain')),
  payload jsonb CHECK (payload IS NULL OR (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=262144)),
  actor_provenance jsonb CHECK (actor_provenance IS NULL OR (jsonb_typeof(actor_provenance)='object' AND octet_length(actor_provenance::text)<=4096)),
  generation integer NOT NULL CHECK (generation > 0),
  execution_id text CHECK (execution_id IS NULL OR execution_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  result_code text CHECK (result_code IS NULL OR result_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  result jsonb CHECK (result IS NULL OR (jsonb_typeof(result)='object' AND octet_length(result::text)<=196608)),
  credential_run_info jsonb CHECK (credential_run_info IS NULL OR (jsonb_typeof(credential_run_info)='object' AND octet_length(credential_run_info::text)<=4096)),
  history_record_sequence bigint CHECK (history_record_sequence >= 0),
  history_event_sequence bigint CHECK (history_event_sequence >= 0),
  history_restore_revision bigint CHECK (history_restore_revision > 0),
  history_incomplete_reason text CHECK (history_incomplete_reason IN ('capture_unavailable','capture_conflict','history_limit','recovery_uncertain')),
  mirror_sequence bigint NOT NULL CHECK (mirror_sequence > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,id,org_id),
  UNIQUE (workspace_id,writer_epoch,conversation_id,position),
  UNIQUE (workspace_id,conversation_id,user_message_id),
  FOREIGN KEY (workspace_id,writer_epoch,org_id)
    REFERENCES cloud_workspace_local_command_writers(workspace_id,writer_epoch,org_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,projection_epoch,conversation_id,org_id)
    REFERENCES cloud_workspace_local_command_controls(workspace_id,writer_epoch,conversation_id,org_id) ON DELETE CASCADE,
  CHECK ((state IN ('queued','dispatching'))=(payload IS NOT NULL)),
  CHECK (state<>'dispatching' OR execution_id IS NOT NULL),
  CHECK (state<>'queued' OR credential_run_info IS NULL),
  CHECK (state IN ('queued','dispatching') OR history_restore_revision IS NOT NULL),
  CHECK (state IN ('queued','dispatching') OR history_incomplete_reason IS NOT NULL
    OR num_nonnulls(history_record_sequence,history_event_sequence)=2)
);
CREATE INDEX cloud_local_commands_history ON cloud_workspace_local_commands(workspace_id,conversation_id,created_at DESC,id);

-- Immutable canonical bytes are staged before the terminal projection is
-- visible. Local live sequence and compact outbox sequence are distinct.
CREATE TABLE cloud_workspace_local_command_history_parts (
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  projection_epoch uuid NOT NULL,
  document_sha256 bytea NOT NULL CHECK (octet_length(document_sha256)=32),
  kind text NOT NULL CHECK (kind IN ('record','manifest')),
  part_index integer NOT NULL CHECK (part_index>=0),
  part_count integer NOT NULL CHECK (part_count BETWEEN 1 AND 32),
  document_bytes integer NOT NULL CHECK (document_bytes>0),
  data bytea NOT NULL,
  outbox_sequence bigint NOT NULL CHECK (outbox_sequence>0),
  PRIMARY KEY (workspace_id,projection_epoch,document_sha256,part_index),
  FOREIGN KEY (workspace_id,projection_epoch,org_id)
    REFERENCES cloud_workspace_local_command_writers(workspace_id,writer_epoch,org_id) ON DELETE CASCADE,
  CHECK (part_index<part_count),
  CHECK (document_bytes>(part_count-1)*131072 AND document_bytes<=part_count*131072),
  CHECK (document_bytes<=CASE WHEN kind='record' THEN 524288 ELSE 4194304 END),
  CHECK (octet_length(data)=CASE WHEN part_index+1<part_count THEN 131072 ELSE document_bytes-part_index*131072 END)
);

CREATE TABLE cloud_workspace_local_command_history_blobs (
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  document_sha256 bytea NOT NULL CHECK (octet_length(document_sha256)=32),
  kind text NOT NULL CHECK (kind IN ('record','manifest')),
  canonical_document text NOT NULL,
  origin_writer_epoch uuid NOT NULL,
  verified_sequence bigint NOT NULL CHECK (verified_sequence>0),
  PRIMARY KEY (workspace_id,document_sha256),
  UNIQUE (workspace_id,document_sha256,org_id),
  FOREIGN KEY (workspace_id,origin_writer_epoch,org_id)
    REFERENCES cloud_workspace_local_command_writers(workspace_id,writer_epoch,org_id) ON DELETE CASCADE,
  CHECK (octet_length(canonical_document)>0 AND octet_length(canonical_document)<=CASE WHEN kind='record' THEN 524288 ELSE 4194304 END),
  CHECK (jsonb_typeof(canonical_document::jsonb)='object'),
  CHECK (document_sha256=sha256(convert_to(canonical_document,'UTF8')))
);
ALTER TABLE cloud_workspace_local_commands ADD COLUMN history_manifest_sha256 bytea
  CHECK (history_manifest_sha256 IS NULL OR octet_length(history_manifest_sha256)=32);
-- This digest retains immutable local receipt audit, even when remote history
-- quota prevents materializing its blob. Only the separate current history head
-- below authorizes transcript reads and requires a verified blob foreign key.
ALTER TABLE cloud_workspace_local_commands ADD CHECK (
  state IN ('queued','dispatching') OR
  (history_incomplete_reason IS NULL AND history_manifest_sha256 IS NOT NULL
    AND num_nonnulls(history_record_sequence,history_event_sequence)=2) OR
  (history_incomplete_reason IS NOT NULL AND history_manifest_sha256 IS NULL)
);

-- A current FULL snapshot can be an edit/delete/repair, independently of a
-- native command. A newer incomplete head fences every older complete blob.
CREATE TABLE cloud_workspace_local_command_history_heads (
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  projection_epoch uuid NOT NULL,
  origin_writer_epoch uuid NOT NULL,
  conversation_id text NOT NULL CHECK (conversation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  restore_revision bigint NOT NULL CHECK (restore_revision>0),
  complete boolean NOT NULL,
  deleted boolean NOT NULL,
  manifest_sha256 bytea CHECK (manifest_sha256 IS NULL OR octet_length(manifest_sha256)=32),
  record_sequence bigint CHECK (record_sequence>=0),
  event_sequence bigint CHECK (event_sequence>=0),
  incomplete_reason text CHECK (incomplete_reason IN ('capture_unavailable','capture_conflict','history_limit','recovery_uncertain')),
  source_kind text NOT NULL CHECK (source_kind IN ('command','mutation')),
  source_id uuid NOT NULL,
  source jsonb NOT NULL CHECK (jsonb_typeof(source)='object' AND octet_length(source::text)<=2048),
  outbox_sequence bigint NOT NULL CHECK (outbox_sequence>0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,projection_epoch,conversation_id),
  FOREIGN KEY (workspace_id,projection_epoch,org_id)
    REFERENCES cloud_workspace_local_command_writers(workspace_id,writer_epoch,org_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,origin_writer_epoch,org_id)
    REFERENCES cloud_workspace_local_command_writers(workspace_id,writer_epoch,org_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,manifest_sha256,org_id)
    REFERENCES cloud_workspace_local_command_history_blobs(workspace_id,document_sha256,org_id) ON DELETE RESTRICT,
  CHECK ((complete AND manifest_sha256 IS NOT NULL AND record_sequence IS NOT NULL AND event_sequence IS NOT NULL AND incomplete_reason IS NULL)
    OR (NOT complete AND manifest_sha256 IS NULL AND incomplete_reason IS NOT NULL)),
  -- Keep the entire accepted source, including mutation operation and immutable
  -- native intent. A kind/id pair cannot fence contradictory restart replay.
  CHECK ((source->>'kind'=source_kind AND CASE source_kind
    WHEN 'mutation' THEN source ?& ARRAY['kind','mutationId','operation']
      AND source-ARRAY['kind','mutationId','operation']='{}'::jsonb
      AND lower(source->>'mutationId')=source_id::text
      AND source->>'operation' IN ('edit','delete','prune','repair')
    WHEN 'command' THEN source ?& ARRAY['kind','commandId','intent','executionId','nativeResultSha256']
      AND source-ARRAY['kind','commandId','intent','executionId','nativeResultSha256']='{}'::jsonb
      AND lower(source->>'commandId')=source_id::text
      AND jsonb_typeof(source->'intent')='object'
      AND (source->'intent') ?& ARRAY['userMessageId','agentId']
      AND (source->'intent')-ARRAY['userMessageId','agentId']='{}'::jsonb
      AND jsonb_typeof(source->'intent'->'userMessageId')='string'
      AND source->'intent'->>'userMessageId' ~ '^[A-Za-z0-9._:-]{1,128}$'
      AND jsonb_typeof(source->'intent'->'agentId')='string'
      AND length(source->'intent'->>'agentId') BETWEEN 1 AND 64
      AND (source->'executionId'='null'::jsonb OR (jsonb_typeof(source->'executionId')='string'
        AND source->>'executionId' ~ '^[A-Za-z0-9._:-]{1,128}$'))
      AND (source->'nativeResultSha256'='null'::jsonb OR (jsonb_typeof(source->'nativeResultSha256')='string'
        AND source->>'nativeResultSha256' ~ '^[a-f0-9]{64}$'))
    ELSE false END) IS TRUE)
);

CREATE FUNCTION preserve_cloud_local_history_head() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF ROW(NEW.workspace_id,NEW.org_id,NEW.projection_epoch,NEW.conversation_id)
      IS DISTINCT FROM ROW(OLD.workspace_id,OLD.org_id,OLD.projection_epoch,OLD.conversation_id)
    OR NEW.restore_revision<OLD.restore_revision OR NEW.outbox_sequence<OLD.outbox_sequence
    OR (NEW.restore_revision=OLD.restore_revision AND ROW(NEW.origin_writer_epoch,NEW.complete,NEW.deleted,
       NEW.manifest_sha256,NEW.record_sequence,NEW.event_sequence,NEW.incomplete_reason,NEW.source_kind,NEW.source_id,NEW.source)
      IS DISTINCT FROM ROW(OLD.origin_writer_epoch,OLD.complete,OLD.deleted,OLD.manifest_sha256,
       OLD.record_sequence,OLD.event_sequence,OLD.incomplete_reason,OLD.source_kind,OLD.source_id,OLD.source)) THEN
    RAISE EXCEPTION 'local history head revision is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_local_history_head_identity BEFORE UPDATE ON cloud_workspace_local_command_history_heads
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_local_history_head();

CREATE TABLE cloud_workspace_local_agent_controls (
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  projection_epoch uuid NOT NULL,
  outbox_sequence bigint NOT NULL CHECK (outbox_sequence>0),
  local_stream_id uuid NOT NULL,
  local_sequence bigint NOT NULL CHECK (local_sequence>0),
  conversation_id text NOT NULL CHECK (conversation_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  execution_id text NOT NULL CHECK (execution_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  command_id uuid NOT NULL,
  user_message_id text NOT NULL CHECK (user_message_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  agent_id text NOT NULL CHECK (agent_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  resolver_id text NOT NULL CHECK (octet_length(resolver_id) BETWEEN 1 AND 8192),
  type text NOT NULL CHECK (type IN ('AGENT_PERMISSION_REQUEST','AGENT_PERMISSION_SETTLED','AGENT_QUESTION_REQUEST','AGENT_QUESTION_SETTLED')),
  frame jsonb NOT NULL CHECK (jsonb_typeof(frame)='object' AND octet_length(frame::text)<=262144),
  PRIMARY KEY (workspace_id,projection_epoch,outbox_sequence),
  UNIQUE (workspace_id,local_stream_id,local_sequence),
  FOREIGN KEY (workspace_id,projection_epoch,org_id)
    REFERENCES cloud_workspace_local_command_writers(workspace_id,writer_epoch,org_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,command_id,org_id)
    REFERENCES cloud_workspace_local_commands(workspace_id,id,org_id) ON DELETE CASCADE
);
CREATE INDEX cloud_local_controls_resolver ON cloud_workspace_local_agent_controls
  (workspace_id,conversation_id,execution_id,resolver_id,local_stream_id,local_sequence);

CREATE TABLE cloud_workspace_local_command_mirror_batches (
  workspace_id uuid NOT NULL,
  org_id uuid NOT NULL,
  writer_epoch uuid NOT NULL,
  batch_id uuid NOT NULL,
  request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256)=32),
  after_sequence bigint NOT NULL CHECK (after_sequence >= 0),
  through_sequence bigint NOT NULL CHECK (through_sequence > after_sequence AND through_sequence<=after_sequence+32),
  -- Commit the exact quota feedback with the batch. A lost response must not
  -- recompute an acknowledgement against a changed remote history quota.
  ack jsonb NOT NULL CHECK ((jsonb_typeof(ack)='object' AND pg_column_size(ack)<=65536
    AND (ack - ARRAY['version','writerEpoch','batchId','through','historyLimits']::text[])='{}'::jsonb
    AND jsonb_typeof(ack->'version')='number' AND ack->>'version'='1'
    AND jsonb_typeof(ack->'writerEpoch')='string' AND ack->>'writerEpoch'=writer_epoch::text
    AND jsonb_typeof(ack->'batchId')='string' AND ack->>'batchId'=batch_id::text
    AND jsonb_typeof(ack->'through')='number' AND (ack->>'through')::numeric=through_sequence
    AND (NOT (ack ? 'historyLimits') OR
      (jsonb_typeof(ack->'historyLimits')='array' AND jsonb_array_length(ack->'historyLimits')<=32))) IS TRUE),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,writer_epoch,batch_id),
  FOREIGN KEY (workspace_id,writer_epoch,org_id)
    REFERENCES cloud_workspace_local_command_writers(workspace_id,writer_epoch,org_id) ON DELETE CASCADE
);

CREATE FUNCTION preserve_cloud_local_mirror_ack() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'local mirror acknowledgement is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_local_mirror_ack_identity BEFORE UPDATE ON cloud_workspace_local_command_mirror_batches
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_local_mirror_ack();

CREATE FUNCTION preserve_cloud_local_command_writer() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF ROW(NEW.workspace_id,NEW.org_id,NEW.generation,NEW.engine_instance_id,NEW.boot_id,NEW.writer_epoch,
      NEW.funding_owner_user_id,NEW.funding_owner_epoch,NEW.mode,NEW.funding_scope,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.workspace_id,OLD.org_id,OLD.generation,OLD.engine_instance_id,OLD.boot_id,OLD.writer_epoch,
      OLD.funding_owner_user_id,OLD.funding_owner_epoch,OLD.mode,OLD.funding_scope,OLD.created_at)
    OR NEW.mirrored_sequence<OLD.mirrored_sequence
    OR (OLD.sealed_sequence IS NOT NULL AND (NEW.sealed_sequence IS NULL OR NEW.sealed_sequence<OLD.sealed_sequence))
    OR (OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at)
    OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at)
    OR NOT (NEW.state=OLD.state OR (OLD.state='reserved' AND NEW.state='active') OR (OLD.state='active' AND NEW.state='retired')) THEN
    RAISE EXCEPTION 'local command writer identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_local_command_writer_identity BEFORE UPDATE ON cloud_workspace_local_command_writers
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_local_command_writer();

CREATE FUNCTION preserve_cloud_local_command_terminal() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF ROW(NEW.workspace_id,NEW.org_id,NEW.id,NEW.conversation_id,NEW.writer_epoch,NEW.user_message_id,NEW.agent_id,
       NEW.position,NEW.generation,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.workspace_id,OLD.org_id,OLD.id,OLD.conversation_id,OLD.writer_epoch,OLD.user_message_id,OLD.agent_id,
       OLD.position,OLD.generation,OLD.created_at)
    OR (OLD.execution_id IS NOT NULL AND NEW.execution_id IS DISTINCT FROM OLD.execution_id)
    OR (OLD.credential_run_info IS NOT NULL AND NEW.credential_run_info IS DISTINCT FROM OLD.credential_run_info)
    OR (OLD.state IN ('succeeded','failed','cancelled') AND ROW(NEW.state,NEW.result_code,NEW.result,NEW.history_record_sequence,NEW.history_event_sequence,NEW.history_manifest_sha256,NEW.history_restore_revision,NEW.history_incomplete_reason)
      IS DISTINCT FROM ROW(OLD.state,OLD.result_code,OLD.result,OLD.history_record_sequence,OLD.history_event_sequence,OLD.history_manifest_sha256,OLD.history_restore_revision,OLD.history_incomplete_reason)) THEN
    RAISE EXCEPTION 'local command terminal identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_local_command_terminal_identity BEFORE UPDATE ON cloud_workspace_local_commands
  FOR EACH ROW EXECUTE FUNCTION preserve_cloud_local_command_terminal();

ALTER TABLE cloud_workspace_local_command_writers ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_local_command_writers FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_local_command_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_local_command_controls FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_local_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_local_commands FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_local_command_mirror_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_local_command_mirror_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_local_command_history_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_local_command_history_parts FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_local_command_history_blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_local_command_history_blobs FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_local_agent_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_local_agent_controls FORCE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_local_command_history_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_workspace_local_command_history_heads FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_workspace_local_command_writers FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
CREATE POLICY system_only ON cloud_workspace_local_command_controls FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
CREATE POLICY system_only ON cloud_workspace_local_commands FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
CREATE POLICY system_only ON cloud_workspace_local_command_mirror_batches FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
CREATE POLICY system_only ON cloud_workspace_local_command_history_parts FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
CREATE POLICY system_only ON cloud_workspace_local_command_history_blobs FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
CREATE POLICY system_only ON cloud_workspace_local_agent_controls FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
CREATE POLICY system_only ON cloud_workspace_local_command_history_heads FOR ALL USING(app_is_system()) WITH CHECK(app_is_system());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_workspace_local_command_writers,cloud_workspace_local_command_controls,
  cloud_workspace_local_commands,cloud_workspace_local_command_mirror_batches,cloud_workspace_local_command_history_parts,
  cloud_workspace_local_command_history_blobs,cloud_workspace_local_agent_controls,cloud_workspace_local_command_history_heads TO zeros_app;
