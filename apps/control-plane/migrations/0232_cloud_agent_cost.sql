-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- NULL means no reported cost. Leave old messages uncounted; history reads
-- never parse or aggregate payloads, and this expansion does no backfill.
ALTER TABLE cloud_v2_messages
  ADD COLUMN agent_cost_usd numeric,
  ADD COLUMN agent_cost_estimated boolean NOT NULL DEFAULT false;
ALTER TABLE cloud_v2_messages ADD CONSTRAINT cloud_v2_message_agent_cost
  CHECK ((agent_cost_usd IS NULL AND NOT agent_cost_estimated)
    OR (agent_cost_usd IS NOT NULL AND agent_cost_usd BETWEEN 0 AND 9007199254740991)) NOT VALID;
ALTER TABLE cloud_v2_workspaces
  ADD COLUMN agent_cost_usd numeric NOT NULL DEFAULT 0,
  ADD COLUMN agent_cost_turns bigint NOT NULL DEFAULT 0,
  ADD COLUMN agent_cost_estimated_turns bigint NOT NULL DEFAULT 0;
ALTER TABLE cloud_v2_workspaces ADD CONSTRAINT cloud_v2_workspace_agent_cost
  CHECK (agent_cost_usd >= 0 AND agent_cost_usd < 'Infinity'::numeric AND agent_cost_turns >= 0
    AND agent_cost_estimated_turns BETWEEN 0 AND agent_cost_turns) NOT VALID;

-- Released CP replicas write opaque payloads. Derive the contribution here
-- so their rewrites/deletions obey the same accounting as a new replica.
CREATE FUNCTION cloud_v2_message_agent_cost() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE document jsonb; usage jsonb; cost numeric;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.kind IS NOT DISTINCT FROM NEW.kind AND OLD.payload IS NOT DISTINCT FROM NEW.payload THEN
    NEW.agent_cost_usd := OLD.agent_cost_usd;
    NEW.agent_cost_estimated := OLD.agent_cost_estimated;
    RETURN NEW;
  END IF;
  NEW.agent_cost_usd := NULL;
  NEW.agent_cost_estimated := false;
  IF NEW.kind <> 'text' OR strpos(NEW.payload, '"totalCostUsd"') = 0 THEN RETURN NEW; END IF;
  BEGIN
    document := NEW.payload::jsonb;
  EXCEPTION WHEN data_exception OR program_limit_exceeded THEN
    RETURN NEW;
  END;
  IF document->>'role' IS DISTINCT FROM 'user' OR document->>'steeredTurnId' IS NOT NULL THEN RETURN NEW; END IF;
  usage := document->'turnSummary'->'usage';
  IF jsonb_typeof(usage->'totalCostUsd') IS DISTINCT FROM 'number' THEN RETURN NEW; END IF;
  IF usage ? 'costKind' AND usage->'costKind' NOT IN ('"estimated"'::jsonb, '"reported"'::jsonb) THEN RETURN NEW; END IF;
  cost := (usage->>'totalCostUsd')::numeric;
  IF cost < 0 OR cost > 9007199254740991 THEN RETURN NEW; END IF;
  NEW.agent_cost_usd := cost;
  NEW.agent_cost_estimated := coalesce(usage->>'costKind' = 'estimated', false);
  RETURN NEW;
END $$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from the new message-cost trigger function
REVOKE ALL ON FUNCTION cloud_v2_message_agent_cost() FROM PUBLIC;

CREATE TRIGGER cloud_v2_messages_agent_cost BEFORE INSERT OR UPDATE OF kind,payload ON cloud_v2_messages
  FOR EACH ROW WHEN (NEW.agent_cost_usd IS NOT NULL OR NEW.agent_cost_estimated
    OR (NEW.kind = 'text' AND strpos(NEW.payload, '"totalCostUsd"') > 0))
  EXECUTE FUNCTION cloud_v2_message_agent_cost();

-- Transition tables bound work to this statement's changed rows. Ordinary
-- transcript batches and unchanged replays perform no workspace UPDATE.
CREATE FUNCTION cloud_v2_adjust_agent_cost() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE changes jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT jsonb_agg(to_jsonb(delta)) INTO changes FROM (
      SELECT workspace_id, sum(agent_cost_usd) AS usd, count(*) AS turns,
        count(*) FILTER (WHERE agent_cost_estimated) AS estimated
      FROM new_rows WHERE agent_cost_usd IS NOT NULL GROUP BY workspace_id
    ) delta;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT jsonb_agg(to_jsonb(delta)) INTO changes FROM (
      SELECT workspace_id, -sum(agent_cost_usd) AS usd, -count(*) AS turns,
        -count(*) FILTER (WHERE agent_cost_estimated) AS estimated
      FROM old_rows WHERE agent_cost_usd IS NOT NULL GROUP BY workspace_id
    ) delta;
  ELSE
    SELECT jsonb_agg(to_jsonb(delta)) INTO changes FROM (
      SELECT workspace_id, sum(usd) AS usd, sum(turns) AS turns, sum(estimated) AS estimated
      FROM (
        SELECT workspace_id, agent_cost_usd AS usd, 1 AS turns, agent_cost_estimated::integer AS estimated
          FROM new_rows WHERE agent_cost_usd IS NOT NULL
        UNION ALL
        SELECT workspace_id, -agent_cost_usd AS usd, -1 AS turns, -agent_cost_estimated::integer AS estimated
          FROM old_rows WHERE agent_cost_usd IS NOT NULL
      ) contributions GROUP BY workspace_id
      HAVING sum(usd) <> 0 OR sum(turns) <> 0 OR sum(estimated) <> 0
    ) delta;
  END IF;
  IF changes IS NULL THEN RETURN NULL; END IF;
  UPDATE cloud_v2_workspaces w SET agent_cost_usd = w.agent_cost_usd + d.usd,
    agent_cost_turns = w.agent_cost_turns + d.turns,
    agent_cost_estimated_turns = w.agent_cost_estimated_turns + d.estimated
  FROM jsonb_to_recordset(changes) AS d(workspace_id uuid, usd numeric, turns bigint, estimated bigint)
  WHERE w.id = d.workspace_id AND (d.usd <> 0 OR d.turns <> 0 OR d.estimated <> 0);
  RETURN NULL;
END $$;
-- zeros-expand-exception: privilege-tightening Removes PUBLIC EXECUTE only from the new cost-aggregate trigger function
REVOKE ALL ON FUNCTION cloud_v2_adjust_agent_cost() FROM PUBLIC;

CREATE TRIGGER cloud_v2_agent_cost_insert AFTER INSERT ON cloud_v2_messages
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION cloud_v2_adjust_agent_cost();
CREATE TRIGGER cloud_v2_agent_cost_update AFTER UPDATE ON cloud_v2_messages
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION cloud_v2_adjust_agent_cost();
CREATE TRIGGER cloud_v2_agent_cost_delete AFTER DELETE ON cloud_v2_messages
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION cloud_v2_adjust_agent_cost();
