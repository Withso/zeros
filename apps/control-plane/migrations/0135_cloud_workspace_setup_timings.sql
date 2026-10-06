-- zeros-migration: expand
-- Nullable, closed telemetry on the current fenced execution. Legacy rows and
-- workers remain valid. No authority/readiness decision consumes this column.
SET LOCAL lock_timeout = '5s';
CREATE FUNCTION cloud_workspace_setup_timings_valid(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
DECLARE clock jsonb; span jsonb; total integer := 0; ids text[] := '{}'; sources text[] := '{}';
BEGIN
  IF jsonb_typeof(value) <> 'object' OR octet_length(value::text) > 8192
     OR NOT value ?& ARRAY['version','clocks'] OR value - ARRAY['version','clocks'] <> '{}'::jsonb
     OR value->'version' <> '1'::jsonb OR jsonb_typeof(value->'clocks') <> 'array'
     OR jsonb_array_length(value->'clocks') > 5 THEN RETURN false; END IF;
  FOR clock IN SELECT * FROM jsonb_array_elements(value->'clocks') LOOP
    IF jsonb_typeof(clock) <> 'object' OR NOT clock ?& ARRAY['source','clockId','startedAt','spans']
       OR clock - ARRAY['source','clockId','startedAt','spans'] <> '{}'::jsonb
       OR clock->>'source' NOT IN ('control_plane','boat_transport','setup','attester_preflight','attester_launch')
       OR jsonb_typeof(clock->'source') <> 'string' OR jsonb_typeof(clock->'clockId') <> 'string'
       OR clock->>'clockId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR clock->>'clockId' = ANY(ids) OR clock->>'source' = ANY(sources)
       OR jsonb_typeof(clock->'startedAt') <> 'string'
       OR clock->>'startedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
       OR jsonb_typeof(clock->'spans') <> 'array' THEN RETURN false; END IF;
    PERFORM (clock->>'startedAt')::timestamptz;
    ids := array_append(ids, clock->>'clockId'); sources := array_append(sources, clock->>'source');
    total := total + jsonb_array_length(clock->'spans');
    IF total > 32 THEN RETURN false; END IF;
    FOR span IN SELECT * FROM jsonb_array_elements(clock->'spans') LOOP
      IF jsonb_typeof(span) <> 'object' OR NOT span ?& ARRAY['stage','startMs','endMs','outcome']
         OR span - ARRAY['stage','startMs','endMs','outcome'] <> '{}'::jsonb
         OR jsonb_typeof(span->'stage') <> 'string' OR span->>'stage' NOT IN ('admission','provider_command','admission_revoke','bootstrap_probe','ssh_transport','supervisor','template_verify','image_preflight','repository','credential_projection','image_launch','engine_launch','engine_readiness','lock','verify_tree','qualify_engine','run_setup','publish_proof')
         OR jsonb_typeof(span->'outcome') <> 'string' OR span->>'outcome' NOT IN ('passed','failed','cancelled')
         OR jsonb_typeof(span->'startMs') <> 'number' OR jsonb_typeof(span->'endMs') <> 'number'
         OR (span->>'startMs')::numeric <> floor((span->>'startMs')::numeric)
         OR (span->>'endMs')::numeric <> floor((span->>'endMs')::numeric)
         OR (span->>'startMs')::numeric < 0 OR (span->>'endMs')::numeric > 3600000
         OR (span->>'endMs')::numeric < (span->>'startMs')::numeric THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
ALTER TABLE cloud_workspace_setup_runs ADD COLUMN stage_timings jsonb
  CHECK (stage_timings IS NULL OR cloud_workspace_setup_timings_valid(stage_timings));
