-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- Chat tombstones can be removed and recreated. Only workspace erasure ends
-- the cache lineage; existing histories start at revision zero without a scan.
CREATE TABLE cloud_v2_history_cache (
  workspace_id uuid NOT NULL REFERENCES cloud_v2_workspaces(id) ON DELETE CASCADE,
  chat_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  resync_revision bigint NOT NULL CHECK (resync_revision BETWEEN 0 AND revision),
  last_txid bigint NOT NULL,
  last_ord bigint NOT NULL,
  base_ord bigint NOT NULL,
  message_count bigint CHECK (message_count BETWEEN 0 AND 9007199254740991),
  count_initialized_txid bigint,
  CHECK ((message_count IS NULL) = (count_initialized_txid IS NULL)),
  PRIMARY KEY (workspace_id,chat_id)
);
CREATE TABLE cloud_v2_history_changes (
  workspace_id uuid NOT NULL,
  chat_id text NOT NULL,
  msg_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (workspace_id,chat_id,msg_id),
  FOREIGN KEY (workspace_id,chat_id,msg_id) REFERENCES cloud_v2_messages(workspace_id,chat_id,msg_id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX cloud_v2_history_changes_since ON cloud_v2_history_changes(workspace_id,chat_id,revision);
CREATE TABLE cloud_v2_prompt_cache (
  workspace_id uuid NOT NULL REFERENCES cloud_v2_workspaces(id) ON DELETE CASCADE,
  chat_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  last_txid bigint NOT NULL,
  PRIMARY KEY (workspace_id,chat_id)
);

ALTER TABLE cloud_v2_history_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_history_cache FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_history_cache USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_v2_history_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_history_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_history_changes USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE cloud_v2_prompt_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_v2_prompt_cache FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON cloud_v2_prompt_cache USING (app_is_system()) WITH CHECK (app_is_system());

-- One committed transaction is one revision, including multi-statement
-- replacement. Rolled-back and intermediate row revisions cannot be bases.
-- Custom GUCs in a function's SET clause require superuser at CREATE time.
-- Body-local settings preserve the caller's RLS context on every return.
CREATE FUNCTION advance_cloud_history_cache(target_workspace uuid,target_chat text,reset_index boolean,inserted_ord bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE current_revision bigint; current_txid bigint := txid_current(); cached public.cloud_v2_history_cache%ROWTYPE;
  previous_system text := current_setting('app.system',true); previous_protocol text := current_setting('app.cloud_execution_protocol',true);
BEGIN
  PERFORM set_config('app.system','on',true),set_config('app.cloud_execution_protocol','1',true);
  SELECT * INTO cached FROM public.cloud_v2_history_cache WHERE workspace_id=target_workspace AND chat_id=target_chat;
  IF cached.last_txid=current_txid AND (inserted_ord IS NULL OR inserted_ord<=cached.last_ord)
    AND (cached.resync_revision=cached.revision OR (NOT reset_index AND (inserted_ord IS NULL OR inserted_ord>cached.base_ord))) THEN
    PERFORM set_config('app.system',coalesce(previous_system,''),true),set_config('app.cloud_execution_protocol',coalesce(previous_protocol,''),true);
    RETURN cached.revision;
  END IF;
  INSERT INTO public.cloud_v2_history_cache(workspace_id,chat_id,revision,resync_revision,last_txid,last_ord,base_ord)
    SELECT target_workspace,target_chat,1,1,current_txid,coalesce(m.ord,0),coalesce(m.ord,0)
    FROM public.cloud_v2_workspaces w LEFT JOIN LATERAL (
      SELECT ord FROM public.cloud_v2_messages WHERE workspace_id=w.id AND chat_id=target_chat ORDER BY ord DESC LIMIT 1) m ON true
    WHERE w.id=target_workspace
    ON CONFLICT (workspace_id,chat_id) DO UPDATE SET
      revision=cloud_v2_history_cache.revision+(cloud_v2_history_cache.last_txid<>current_txid)::integer,
      resync_revision=CASE WHEN reset_index OR inserted_ord<=CASE WHEN cloud_v2_history_cache.last_txid=current_txid
          THEN cloud_v2_history_cache.base_ord ELSE cloud_v2_history_cache.last_ord END
        THEN cloud_v2_history_cache.revision+(cloud_v2_history_cache.last_txid<>current_txid)::integer
        ELSE cloud_v2_history_cache.resync_revision END,
      base_ord=CASE WHEN cloud_v2_history_cache.last_txid=current_txid THEN cloud_v2_history_cache.base_ord ELSE cloud_v2_history_cache.last_ord END,
      last_txid=current_txid,last_ord=greatest(cloud_v2_history_cache.last_ord,EXCLUDED.last_ord)
    RETURNING revision INTO current_revision;
  PERFORM set_config('app.system',coalesce(previous_system,''),true),set_config('app.cloud_execution_protocol',coalesce(previous_protocol,''),true);
  RETURN current_revision;
END;
$$;

CREATE FUNCTION track_cloud_message_cache() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE current_revision bigint; previous_system text; previous_protocol text;
BEGIN
  IF TG_OP='UPDATE' AND (OLD.workspace_id,OLD.chat_id,OLD.msg_id,OLD.ord,OLD.kind,OLD.payload,OLD.created_at_ms)
    IS NOT DISTINCT FROM (NEW.workspace_id,NEW.chat_id,NEW.msg_id,NEW.ord,NEW.kind,NEW.payload,NEW.created_at_ms) THEN RETURN NULL; END IF;
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (OLD.workspace_id,OLD.chat_id,OLD.msg_id)
    IS DISTINCT FROM (NEW.workspace_id,NEW.chat_id,NEW.msg_id)) THEN
    PERFORM public.advance_cloud_history_cache(OLD.workspace_id,OLD.chat_id,true,NULL);
  END IF;
  IF TG_OP='DELETE' THEN RETURN NULL; END IF;
  current_revision := public.advance_cloud_history_cache(NEW.workspace_id,NEW.chat_id,
    TG_OP='UPDATE' AND (OLD.workspace_id,OLD.chat_id,OLD.msg_id,OLD.ord) IS DISTINCT FROM (NEW.workspace_id,NEW.chat_id,NEW.msg_id,NEW.ord),
    CASE WHEN TG_OP='INSERT' OR OLD.ord IS DISTINCT FROM NEW.ord THEN NEW.ord ELSE NULL END);
  IF current_revision IS NOT NULL THEN
    previous_system := current_setting('app.system',true); previous_protocol := current_setting('app.cloud_execution_protocol',true);
    PERFORM set_config('app.system','on',true),set_config('app.cloud_execution_protocol','1',true);
    INSERT INTO public.cloud_v2_history_changes(workspace_id,chat_id,msg_id,revision)
      VALUES(NEW.workspace_id,NEW.chat_id,NEW.msg_id,current_revision)
      ON CONFLICT (workspace_id,chat_id,msg_id) DO UPDATE SET revision=EXCLUDED.revision;
    PERFORM set_config('app.system',coalesce(previous_system,''),true),set_config('app.cloud_execution_protocol',coalesce(previous_protocol,''),true);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER cloud_v2_message_cache AFTER INSERT OR UPDATE OR DELETE ON cloud_v2_messages
  FOR EACH ROW EXECUTE FUNCTION track_cloud_message_cache();

-- Count once per changed chat, then apply statement deltas. The first
-- transaction recomputes: one UPSERT can fire both UPDATE and INSERT triggers,
-- and both transition tables are already visible to the first count.
CREATE FUNCTION track_cloud_message_count() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE changed record; changes_sql text; current_txid bigint := txid_current();
  previous_system text := current_setting('app.system',true); previous_protocol text := current_setting('app.cloud_execution_protocol',true);
BEGIN
  changes_sql := CASE TG_OP
    WHEN 'INSERT' THEN 'SELECT workspace_id,chat_id,count(*) AS delta FROM cache_new_messages GROUP BY workspace_id,chat_id ORDER BY workspace_id,chat_id'
    WHEN 'DELETE' THEN 'SELECT workspace_id,chat_id,-count(*) AS delta FROM cache_old_messages GROUP BY workspace_id,chat_id ORDER BY workspace_id,chat_id'
    ELSE 'SELECT workspace_id,chat_id,sum(delta)::bigint AS delta FROM (
      SELECT workspace_id,chat_id,1 AS delta FROM cache_new_messages UNION ALL
      SELECT workspace_id,chat_id,-1 AS delta FROM cache_old_messages) changed
      GROUP BY workspace_id,chat_id ORDER BY workspace_id,chat_id'
    END;
  PERFORM set_config('app.system','on',true),set_config('app.cloud_execution_protocol','1',true);
  FOR changed IN EXECUTE changes_sql LOOP
    UPDATE public.cloud_v2_history_cache c SET
      message_count=CASE WHEN c.message_count IS NULL OR c.count_initialized_txid=current_txid THEN
        (SELECT count(*) FROM public.cloud_v2_messages m WHERE m.workspace_id=c.workspace_id AND m.chat_id=c.chat_id)
        ELSE c.message_count+changed.delta END,
      count_initialized_txid=coalesce(c.count_initialized_txid,current_txid)
    WHERE c.workspace_id=changed.workspace_id AND c.chat_id=changed.chat_id
      AND (c.message_count IS NULL OR changed.delta<>0);
  END LOOP;
  PERFORM set_config('app.system',coalesce(previous_system,''),true),set_config('app.cloud_execution_protocol',coalesce(previous_protocol,''),true);
  RETURN NULL;
END;
$$;
CREATE TRIGGER cloud_v2_message_count_insert AFTER INSERT ON cloud_v2_messages
  REFERENCING NEW TABLE AS cache_new_messages FOR EACH STATEMENT EXECUTE FUNCTION track_cloud_message_count();
CREATE TRIGGER cloud_v2_message_count_delete AFTER DELETE ON cloud_v2_messages
  REFERENCING OLD TABLE AS cache_old_messages FOR EACH STATEMENT EXECUTE FUNCTION track_cloud_message_count();
CREATE TRIGGER cloud_v2_message_count_update AFTER UPDATE ON cloud_v2_messages
  REFERENCING OLD TABLE AS cache_old_messages NEW TABLE AS cache_new_messages
  FOR EACH STATEMENT EXECUTE FUNCTION track_cloud_message_count();

CREATE FUNCTION track_cloud_chat_cache() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' AND (OLD.workspace_id,OLD.chat_id,OLD.deleted_at IS NULL,OLD.row->'historyState')
    IS NOT DISTINCT FROM (NEW.workspace_id,NEW.chat_id,NEW.deleted_at IS NULL,NEW.row->'historyState') THEN RETURN NULL; END IF;
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (OLD.workspace_id,OLD.chat_id) IS DISTINCT FROM (NEW.workspace_id,NEW.chat_id)) THEN
    PERFORM public.advance_cloud_history_cache(OLD.workspace_id,OLD.chat_id,true,NULL);
  END IF;
  IF TG_OP<>'DELETE' THEN PERFORM public.advance_cloud_history_cache(NEW.workspace_id,NEW.chat_id,true,NULL); END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER cloud_v2_chat_cache AFTER INSERT OR UPDATE OR DELETE ON cloud_v2_chats
  FOR EACH ROW EXECUTE FUNCTION track_cloud_chat_cache();

-- Receipt changes also come from old replicas, retention and authority
-- triggers. Delivery bookkeeping alone does not change the public snapshot.
CREATE FUNCTION track_cloud_prompt_cache() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE target record; previous_system text; previous_protocol text;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='cloud_v2_prompt_chats' THEN
      IF (OLD.workspace_id,OLD.chat_id,OLD.epoch) IS NOT DISTINCT FROM (NEW.workspace_id,NEW.chat_id,NEW.epoch) THEN RETURN NULL; END IF;
    ELSE
      IF (OLD.workspace_id,OLD.chat_id,OLD.creator_user_id,OLD.sequence,OLD.receipt,OLD.payload,OLD.state,OLD.cancel_requested)
        IS NOT DISTINCT FROM (NEW.workspace_id,NEW.chat_id,NEW.creator_user_id,NEW.sequence,NEW.receipt,NEW.payload,NEW.state,NEW.cancel_requested) THEN RETURN NULL; END IF;
    END IF;
  END IF;
  previous_system := current_setting('app.system',true); previous_protocol := current_setting('app.cloud_execution_protocol',true);
  PERFORM set_config('app.system','on',true),set_config('app.cloud_execution_protocol','1',true);
  FOR target IN
    SELECT DISTINCT workspace_id,chat_id FROM (VALUES
      (CASE WHEN TG_OP<>'INSERT' THEN OLD.workspace_id END,CASE WHEN TG_OP<>'INSERT' THEN OLD.chat_id END),
      (CASE WHEN TG_OP<>'DELETE' THEN NEW.workspace_id END,CASE WHEN TG_OP<>'DELETE' THEN NEW.chat_id END)) AS keys(workspace_id,chat_id)
      WHERE workspace_id IS NOT NULL ORDER BY workspace_id,chat_id
  LOOP
    INSERT INTO public.cloud_v2_prompt_cache(workspace_id,chat_id,revision,last_txid)
      SELECT target.workspace_id,target.chat_id,1,txid_current()
      WHERE EXISTS (SELECT 1 FROM public.cloud_v2_workspaces WHERE id=target.workspace_id)
      ON CONFLICT (workspace_id,chat_id) DO UPDATE SET
        revision=cloud_v2_prompt_cache.revision+1,last_txid=txid_current()
      WHERE cloud_v2_prompt_cache.last_txid<>txid_current();
  END LOOP;
  PERFORM set_config('app.system',coalesce(previous_system,''),true),set_config('app.cloud_execution_protocol',coalesce(previous_protocol,''),true);
  RETURN NULL;
END;
$$;
CREATE TRIGGER cloud_v2_prompt_cache AFTER INSERT OR UPDATE OR DELETE ON cloud_v2_prompt_outbox
  FOR EACH ROW EXECUTE FUNCTION track_cloud_prompt_cache();
CREATE TRIGGER cloud_v2_prompt_chat_cache AFTER INSERT OR UPDATE OR DELETE ON cloud_v2_prompt_chats
  FOR EACH ROW EXECUTE FUNCTION track_cloud_prompt_cache();

-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from new cache tracking functions
REVOKE ALL ON FUNCTION advance_cloud_history_cache(uuid,text,boolean,bigint) FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from new cache tracking functions
REVOKE ALL ON FUNCTION track_cloud_message_cache() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from new cache tracking functions
REVOKE ALL ON FUNCTION track_cloud_message_count() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from new cache tracking functions
REVOKE ALL ON FUNCTION track_cloud_chat_cache() FROM PUBLIC;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from new cache tracking functions
REVOKE ALL ON FUNCTION track_cloud_prompt_cache() FROM PUBLIC;
