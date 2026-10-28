-- zeros-migration: expand
SET LOCAL lock_timeout = '5s';

-- These bindings are server observations, separate from the editable recipe.
-- NULL means unknown, including every pre-existing build. Resolving a reusable
-- name today cannot establish which source an old log or recipe came from.
ALTER TABLE cloud_v2_computer_builds ADD COLUMN source_targets jsonb
  CHECK (source_targets IS NULL OR jsonb_typeof(source_targets) = 'array');
ALTER TABLE cloud_v2_computers ADD COLUMN recipe_source_targets jsonb
  CHECK (recipe_source_targets IS NULL OR jsonb_typeof(recipe_source_targets) = 'array');

-- Record before queueing/credentials/output; even failed and interrupted
-- builds keep their original binding. Build completion may pin commits and
-- branch observations, but must not replace the source or its setup recipe.
CREATE FUNCTION cloud_v2_preserve_computer_sources() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF OLD.source_targets IS DISTINCT FROM NEW.source_targets THEN
    RAISE EXCEPTION 'computer source identities are immutable';
  END IF;
  IF OLD.source_targets IS NOT NULL AND (
    (OLD.recipe - 'repositories') IS DISTINCT FROM (NEW.recipe - 'repositories') OR
    (SELECT jsonb_agg(entry - 'commit' - 'branch' ORDER BY position)
      FROM jsonb_array_elements(OLD.recipe->'repositories') WITH ORDINALITY AS items(entry, position))
    IS DISTINCT FROM
    (SELECT jsonb_agg(entry - 'commit' - 'branch' ORDER BY position)
      FROM jsonb_array_elements(NEW.recipe->'repositories') WITH ORDINALITY AS items(entry, position))
  ) THEN
    RAISE EXCEPTION 'computer source recipe is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_v2_preserve_computer_sources BEFORE UPDATE OF source_targets,recipe
ON cloud_v2_computer_builds FOR EACH ROW EXECUTE FUNCTION cloud_v2_preserve_computer_sources();
-- zeros-expand-exception: privilege-tightening Withdraws PUBLIC EXECUTE on a new trigger-only function; existing callers retain their privileges.
REVOKE ALL ON FUNCTION cloud_v2_preserve_computer_sources() FROM PUBLIC;
